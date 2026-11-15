package main

import (
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

type imageQuantities struct {
	TextTokens   float64
	InputTokens  float64
	OutputTokens float64
	InputMP      float64
	OutputMP     float64
	Notes        []string
}

type megapixelPricing struct {
	First      float64
	Additional float64
	Input      float64
}

var (
	// The endpoint API currently omits FLUX.2's subsequent-MP and input rates.
	// https://openrouter.ai/black-forest-labs/flux.2-pro
	fluxMegapixelPricing = map[string]megapixelPricing{
		"black-forest-labs/flux.2-pro":      {First: 0.03, Additional: 0.015, Input: 0.015},
		"black-forest-labs/flux.2-max":      {First: 0.07, Additional: 0.03, Input: 0.03},
		"black-forest-labs/flux.2-flex":     {First: 0.06, Additional: 0.06, Input: 0.06},
		"black-forest-labs/flux.2-klein-4b": {First: 0.014, Additional: 0.001},
	}

	// GPT Image 2.5 and 2.6 share quality axes, but 2.6 scales low/medium tokens.
	// https://developers.openai.com/api/docs/guides/image-generation#calculating-costs
	gptImage25QualityAxis = map[string]int64{
		"low": 16, "medium": 24, "high": 48, "xhigh": 64, "max": 96,
	}

	gptImage26TokenMultiplier = map[string]float64{
		"low": 4.2, "medium": 3.3,
	}
)

func estimateModelCost(request EstimateRequest, model *Model) EstimateResponse {
	quantities := estimateImageQuantities(request)
	result := EstimateResponse{Source: "unavailable"}

	var (
		costs         []float64
		missingPrices = 0
	)

	for _, endpoint := range model.PriceEndpoints {
		if !supportsEstimate(endpoint, request) {
			continue
		}

		lines := supplementImagePrices(model, endpoint.Pricing)

		cost, complete := estimateEndpointCost(request, lines, quantities)
		if complete {
			costs = append(costs, cost)
		} else {
			missingPrices++
		}
	}

	if len(costs) > 0 {
		result.Available = true
		result.Estimate = slices.Min(costs)
		result.Maximum = slices.Max(costs)
		result.Source = "endpoint"

		for _, endpoint := range model.PriceEndpoints {
			for _, line := range endpoint.Pricing {
				if line.Unit == "token" {
					result.Notes = slices.Clone(quantities.Notes)

					break
				}
			}
		}

		if missingPrices > 0 {
			result.Notes = append(result.Notes, "Providers without usable pricing are excluded from this estimate.")
		}

		if result.Maximum > result.Estimate {
			result.Notes = append(result.Notes, "Range reflects eligible provider prices; routing determines the actual charge.")
		}
	} else {
		result = estimateFallbackCost(request, quantities)
	}

	if model.PricingStale && result.Available {
		result.Notes = append(result.Notes, "Pricing refresh failed; using the last available rates.")
	}

	if strings.HasPrefix(request.Model, "sourceful/riverflow-v2.5-") || strings.HasPrefix(request.Model, "sourceful/riverflow-v2.6-") {
		result.Notes = append(result.Notes, "Starting-price estimate; billable processing and editing complexity can increase the final cost.")
	}

	if strings.HasPrefix(request.Model, "openai/gpt-5") || strings.HasPrefix(request.Model, "google/") {
		result.Notes = append(result.Notes, "Additional generated text, reasoning, and tool charges are not included.")
	}

	if _, ok := fluxMegapixelPricing[request.Model]; ok {
		result.Notes = append(result.Notes, "FLUX.2 uses published first/additional megapixel rates; dimensions and billable megapixel rounding are approximate.")
	}

	result.Estimate = roundUSD(result.Estimate)
	result.Maximum = roundUSD(result.Maximum)

	if result.Maximum == result.Estimate {
		result.Maximum = 0
	}

	return result
}

func estimateEndpointCost(request EstimateRequest, pricing []ImagePriceLine, quantities imageQuantities) (float64, bool) {
	lines, hasOutput := selectImagePrices(request, pricing)
	if !hasOutput {
		return 0, false
	}

	var cost float64

	for _, line := range lines {
		if line.CostUSD == nil || math.IsNaN(*line.CostUSD) || math.IsInf(*line.CostUSD, 0) || *line.CostUSD < 0 {
			return 0, false
		}

		quantity, known := imageBillableQuantity(request, line, quantities)
		if !known || quantity < 0 {
			return 0, false
		}

		cost += quantity * *line.CostUSD
	}

	// Replace the incomplete FLUX.2 megapixel line, not the whole request.
	if rates, ok := fluxMegapixelPricing[request.Model]; ok {
		for _, line := range lines {
			if line.Billable == "output_image" && line.Unit == "megapixel" {
				cost -= quantities.OutputMP * *line.CostUSD
				cost += rates.First + math.Max(0, quantities.OutputMP-1)*rates.Additional + quantities.InputMP*rates.Input
			}
		}
	}

	return cost, true
}

func imageBillableQuantity(request EstimateRequest, line ImagePriceLine, quantities imageQuantities) (float64, bool) {
	switch line.Billable {
	case "input_font":
		// Paws does not send font_inputs.
		return 0, true
	case "input_reference":
		if strings.HasPrefix(request.Model, "sourceful/") {
			// This fee is for super_resolution_references, not ordinary edits.
			return 0, true
		}

		fallthrough
	case "input_image":
		switch line.Unit {
		case "image":
			return float64(len(request.References)), true
		case "request":
			if len(request.References) > 0 {
				return 1, true
			}

			return 0, true
		case "token":
			return quantities.InputTokens, true
		case "megapixel":
			return quantities.InputMP, true
		}
	case "input_text":
		if line.Unit == "token" {
			return quantities.TextTokens, true
		}
	case "output_image":
		switch line.Unit {
		case "image", "request":
			return 1, true
		case "token":
			return quantities.OutputTokens, true
		case "megapixel":
			return quantities.OutputMP, true
		}
	}

	return 0, false
}

func estimateFallbackCost(request EstimateRequest, quantities imageQuantities) EstimateResponse {
	result := EstimateResponse{Source: "unavailable", Notes: []string{"No usable price or output-token estimate is available for this configuration."}}

	if examples, ok := minimaxImageCostExamples[request.Model]; ok && request.OutputTokens == nil {
		return estimateMiniMaxExample(request, examples)
	}

	var cost float64

	if lines, ok := imageModelPriceLines[request.Model]; ok {
		var complete bool

		cost, complete = estimateEndpointCost(request, lines, quantities)
		if !complete {
			return result
		}
	} else if rates, ok := imageModelTokenRates[request.Model]; ok {
		if quantities.OutputTokens < 0 || quantities.InputTokens < 0 {
			return result
		}

		cost = (quantities.TextTokens*rates.TextIn + quantities.InputTokens*rates.ImageIn + quantities.OutputTokens*rates.ImageOut) / 1e6
	} else if rates, ok := fluxMegapixelPricing[request.Model]; ok {
		cost = rates.First + math.Max(0, quantities.OutputMP-1)*rates.Additional + quantities.InputMP*rates.Input
	} else {
		pricing := ImageModelPricing[request.Model]
		if pricing == nil {
			return result
		}

		cost = pricing.forResolution(request.Resolution)
	}

	result.Available = true
	result.Estimate = cost
	result.Source = "fallback"
	result.Notes = append(slices.Clone(quantities.Notes), "Approximate fallback pricing; provider rates and reference surcharges may differ.")

	return result
}

func estimateImageQuantities(request EstimateRequest) imageQuantities {
	text := request.Prompt

	if request.System != "" {
		text = request.System + "\n\n" + text
	}

	quantities := imageQuantities{TextTokens: math.Ceil(float64(utf8.RuneCountInString(text)) / 4), Notes: []string{"Text tokens are approximated from the prompt and system message (four characters per token)."}}
	longEdge := resolutionEdge(request.Resolution)

	ratioWidth, ratioHeight, explicit := parseAspect(request.Aspect)
	if !explicit {
		ratioWidth, ratioHeight, _ = aspectFromReferences(request.References)
		if ratioWidth == 0 {
			ratioWidth = 1
			ratioHeight = 1
		}
	}

	width, height := sizeFromLongEdge(longEdge, ratioWidth, ratioHeight)
	quantities.OutputMP = math.Max(1, math.Ceil(float64(width)*float64(height)/1048576))

	for _, reference := range request.References {
		quantities.InputMP += math.Max(1, math.Ceil(float64(reference.Width)*float64(reference.Height)/1048576))
		quantities.InputTokens += float64(gptImage2ReferenceTokens(reference.Width, reference.Height))
	}

	quality := request.Quality
	if quality == "auto" || quality == "" {
		quality = "medium"

		if strings.HasPrefix(request.Model, "openai/") {
			quantities.Notes = append(quantities.Notes, "Auto quality is estimated as medium; the model may choose differently.")
		}
	}

	switch request.Model {
	case "openai/gpt-image-2", "openai/gpt-5.4-image-2", "openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare", "openai/gpt-image-2.6-sunburst", "openai/gpt-image-2.6-flare":
		width, height = resolveGPTImage2Size(request)
		axis := gptImage2QualityAxis[quality]

		if strings.HasPrefix(request.Model, "openai/gpt-image-2.5-") || strings.HasPrefix(request.Model, "openai/gpt-image-2.6-") {
			axis = gptImage25QualityAxis[quality]
		}

		quantities.OutputTokens = float64(gptImageOutputTokens(width, height, axis))

		if strings.HasPrefix(request.Model, "openai/gpt-image-2.6-") {
			if multiplier, ok := gptImage26TokenMultiplier[quality]; ok {
				// OpenAI rounds after multiplying the already-ceiled base token count.
				quantities.OutputTokens = math.Round(quantities.OutputTokens * multiplier)
			}
		}

		quantities.Notes = append(quantities.Notes, "Output dimensions and reference tokenization are estimated; provider-selected sizes can differ.")
	case "openai/gpt-image-1", "openai/gpt-5-image":
		quantities.OutputTokens = float64(gptImage1OutputTokens[resolveGPTImage1Size(request)][quality])
		quantities.InputTokens = 0

		for _, reference := range request.References {
			quantities.InputTokens += float64(gptImage1ReferenceTokens(reference.Width, reference.Height))
		}
	case "openai/gpt-image-1-mini", "openai/gpt-5-image-mini":
		// Published per-image estimates differ from GPT Image 1's token table.
		// https://developers.openai.com/api/docs/guides/image-generation#calculating-costs
		prices := map[string]float64{"low": 0.005, "medium": 0.011, "high": 0.036}

		if resolveGPTImage1Size(request) != "1024x1024" {
			prices = map[string]float64{"low": 0.006, "medium": 0.015, "high": 0.052}
		}

		quantities.OutputTokens = prices[quality] / 0.000008
		quantities.Notes = append(quantities.Notes, "Mini output uses the published rounded per-image estimates; reference tokens are approximate.")
	case "google/gemini-2.5-flash-image":
		quantities.OutputTokens = 1290
		quantities.InputTokens = float64(len(request.References) * 1290)
	case "google/gemini-3-pro-image", "google/gemini-3-pro-image-preview":
		quantities.OutputTokens = 1120

		if request.Resolution == "4K" {
			quantities.OutputTokens = 2000
		}

		quantities.InputTokens = float64(len(request.References) * 560)
	case "google/gemini-3.1-flash-image", "google/gemini-3.1-flash-image-preview", "google/gemini-3.1-flash-lite-image", "google/gemini-nano-banana-2.1":
		// https://ai.google.dev/gemini-api/docs/pricing
		quantities.OutputTokens = 1120

		switch request.Resolution {
		case "512":
			quantities.OutputTokens = 747
		case "2K":
			quantities.OutputTokens = 1680
		case "4K":
			quantities.OutputTokens = 2520
		}
	case "tencent/hy-world-2.1-panorama":
		// https://www.tencentcloud.com/document/product/1300/78937
		quantities.OutputTokens = 481250
	case "minimax/minimax-h3-image", "minimax/minimax-h3-image-highspeed":
		quantities.OutputTokens = -1
		quantities.InputTokens = 0

		if len(request.References) > 0 {
			quantities.InputTokens = -1
		}

		quantities.Notes = append(quantities.Notes, "MiniMax does not publish a complete image-token formula; prompt-enhancement charges are not included in token-budget estimates.")
	case "tencent/hy-image-v3.5-preview":
		// https://www.tencentcloud.com/document/product/1300/78937
		quantities.OutputTokens = 15000

		if request.Resolution == "4K" {
			quantities.OutputTokens = 20000
		}

		if request.Resolution == "1.5K" {
			quantities.Notes = append(quantities.Notes, "1.5K uses the published 1K/2K token allowance.")
		}
	case "microsoft/mai-image-2.5", "microsoft/mai-image-2.5-pro", "microsoft/mai-image-2.6", "microsoft/mai-image-2.6-flash":
		// Approximately 1,024 tokens reproduce the measured baselines in model_data.go.
		quantities.OutputTokens = 1024
		quantities.Notes = append(quantities.Notes, "MAI estimate uses a measured 1,024-token output baseline; reference tokens are approximate.")
	default:
		quantities.OutputTokens = -1
	}

	if request.OutputTokens != nil {
		quantities.OutputTokens = float64(*request.OutputTokens)
		quantities.Notes = append(quantities.Notes, "Using the supplied output-token budget.")
	}

	if strings.HasPrefix(request.Model, "google/") && len(request.References) > 0 {
		quantities.Notes = append(quantities.Notes, "Reference-image token counts and catalog input rates are approximate.")
	}

	return quantities
}

func resolutionEdge(resolution string) int {
	switch resolution {
	case "512":
		return 512
	case "768":
		return 768
	case "1.5K":
		return 1536
	case "2K":
		return 2048
	case "4K":
		return 4096
	default:
		return 1024
	}
}

func gptImage1ReferenceTokens(width, height int) int {
	scale := math.Min(1, 2048/float64(max(width, height)))
	scale = math.Min(scale, 512/float64(min(width, height)))
	width = max(1, int(math.Floor(float64(width)*scale)))
	height = max(1, int(math.Floor(float64(height)*scale)))

	return 65 + 129*ceilDiv(width, 512)*ceilDiv(height, 512)
}
