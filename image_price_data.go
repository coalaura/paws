package main

// OpenRouter Image API rates, verified 2026-11-15. Live endpoint rates take precedence.
// https://openrouter.ai/api/v1/images/models/{model}/endpoints
// Keep tier and reference charges together so offline estimates use the same billing rules.
var imageModelPriceLines = map[string][]ImagePriceLine{
	"recraft/recraft-v4.1-flash-v2": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.007)},
	},
	"recraft/recraft-v4.1-flash": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.007)},
	},
	"bytedance-seed/seedream-5-5": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.02)},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.035), Variant: "high_resolution"},
		{Billable: "input_image", Unit: "image", CostUSD: new(0.008)},
	},
	"sourceful/riverflow-v2.6-pro": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.13)},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.15), Variant: "2k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.17), Variant: "4k"},
	},
	"qwen/qwen-image-2.1-turbo": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.0184), Variant: "1k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.0184), Variant: "2k"},
	},
	"qwen/qwen-image-2.1-pro": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.046), Variant: "1k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.046), Variant: "2k"},
	},
	"krea/k3-edit": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.03)},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.06), Variant: "2k"},
		{Billable: "input_image", Unit: "image", CostUSD: new(0.02)},
		{Billable: "input_image", Unit: "image", CostUSD: new(0.07), Variant: "2k"},
	},
	"black-forest-labs/flux-3-image-klein": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.008), Variant: "768"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.009), Variant: "1k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.011), Variant: "1.5k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.014), Variant: "2k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.036), Variant: "4k"},
	},
	"black-forest-labs/flux-3-image": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.041), Variant: "768"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.048), Variant: "1k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.07), Variant: "1.5k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.1), Variant: "2k"},
		{Billable: "output_image", Unit: "image", CostUSD: new(0.607), Variant: "4k"},
	},
	"bytedance-seed/seedream-5-0-flash": {
		{Billable: "output_image", Unit: "image", CostUSD: new(0.018)},
	},
}

// MiniMax publishes example totals, not a complete tokenization formula. These
// undiscounted examples include prompt enhancement and square 1K references.
// https://platform.minimax.io/docs/guides/pricing-paygo#example-cost-per-generated-image
var minimaxImageCostExamples = map[string]map[int]ImagePricing{
	"minimax/minimax-h3-image": {
		0: {K1: 0.02179, K2: 0.02333, K4: 0.06879},
		1: {K1: 0.02654, K2: 0.02658, K4: 0.07312},
		3: {K1: 0.03563, K2: 0.04177, K4: 0.07914},
	},
	"minimax/minimax-h3-image-highspeed": {
		0: {K1: 0.03529, K2: 0.03622, K4: 0.13001},
		1: {K1: 0.04525, K2: 0.04576, K4: 0.13673},
		3: {K1: 0.06037, K2: 0.06069, K4: 0.15407},
	},
}

func estimateMiniMaxExample(request EstimateRequest, examples map[int]ImagePricing) EstimateResponse {
	result := EstimateResponse{
		Source: "unavailable",
		Notes:  []string{"MiniMax publishes illustrative costs for square outputs with zero, one, or three 1024x1024 references; no verified token formula is available for this configuration."},
	}

	if request.Aspect != "" && request.Aspect != "auto" && request.Aspect != "1:1" {
		return result
	}

	if request.Resolution != "1K" && request.Resolution != "2K" && request.Resolution != "4K" {
		return result
	}

	for _, reference := range request.References {
		if reference.Width != 1024 || reference.Height != 1024 {
			return result
		}
	}

	pricing, present := examples[len(request.References)]
	if !present {
		return result
	}

	result.Available = true
	result.Estimate = pricing.forResolution(request.Resolution)
	result.Source = "fallback"
	result.Notes = []string{
		"Published MiniMax example total for a square image, including example prompt-enhancement charges; actual text and enhancement usage can change the cost.",
		"Uses undiscounted standard pricing; direct-provider promotions are not assumed to apply through OpenRouter.",
	}

	return result
}
