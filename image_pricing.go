package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coalaura/openingrouter"
)

// https://openrouter.ai/docs/guides/overview/multimodal/image-generation
type ImagePriceLine struct {
	Billable string   `json:"billable"`
	Unit     string   `json:"unit"`
	CostUSD  *float64 `json:"cost_usd"`
	Variant  string   `json:"variant"`
}

type ImagePriceEndpoint struct {
	Provider            string                                 `json:"provider_slug"`
	SupportedParameters openingrouter.ImageSupportedParameters `json:"supported_parameters"`
	Pricing             []ImagePriceLine                       `json:"pricing"`
}

type ImagePriceEndpoints struct {
	Endpoints []ImagePriceEndpoint `json:"endpoints"`
}

func loadImagePricing(models []*Model) {
	client := OpenRouterClient()

	refreshContext, stopRefresh := context.WithTimeout(context.Background(), 30*time.Second)
	defer stopRefresh()

	queue := make(chan *Model)

	var workers sync.WaitGroup

	for range 4 {
		workers.Go(func() {
			for model := range queue {
				ctx, cancel := context.WithTimeout(refreshContext, 10*time.Second)

				endpoints, err := fetchImagePricing(ctx, client, model.ID)

				cancel()

				if err != nil {
					previous := GetModel(model.ID)
					if previous != nil {
						model.PriceEndpoints = previous.PriceEndpoints
					}

					model.PricingStale = true

					log.Warnf("Pricing for %s: %v\n", model.ID, err)
				} else {
					model.PriceEndpoints = endpoints
				}

				model.Pricing = imagePricingBadges(model)
			}
		})
	}

	for _, model := range models {
		queue <- model
	}

	close(queue)
	workers.Wait()
}

func fetchImagePricing(ctx context.Context, client *openingrouter.Client, model string) ([]ImagePriceEndpoint, error) {
	request, err := client.NewRequest(ctx, http.MethodGet, "images/models/"+model+"/endpoints", nil)
	if err != nil {
		return nil, err
	}

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}

	defer response.Body.Close()

	var result ImagePriceEndpoints

	err = json.NewDecoder(response.Body).Decode(&result)
	if err != nil {
		return nil, err
	}

	if len(result.Endpoints) == 0 {
		return nil, fmt.Errorf("no pricing endpoints")
	}

	return result.Endpoints, nil
}

func imagePricingBadges(model *Model) *ImagePricing {
	pricing := &ImagePricing{}

	resolutions := model.Options.Resolutions
	if len(resolutions) == 0 {
		resolutions = []string{"1K"}
	}

	for _, resolution := range resolutions {
		request := EstimateRequest{Model: model.ID, Resolution: resolution, Quality: "auto", Aspect: "1:1"}

		if len(model.Options.Resolutions) == 0 {
			request.Resolution = ""
		}

		if len(model.Options.AspectRatios) == 0 {
			request.Aspect = "auto"
		}

		for range model.Options.MinReferences {
			request.References = append(request.References, ReferenceSize{Width: 1024, Height: 1024})
		}

		estimate := estimateModelCost(request, model)
		if !estimate.Available {
			continue
		}

		switch resolution {
		case "1K":
			pricing.K1 = estimate.Estimate
		case "2K":
			pricing.K2 = estimate.Estimate
		case "4K":
			pricing.K4 = estimate.Estimate
		}
	}

	if pricing.K1 == 0 && pricing.K2 == 0 && pricing.K4 == 0 {
		return nil
	}

	return pricing
}

func supportsEstimate(endpoint ImagePriceEndpoint, request EstimateRequest) bool {
	parameters := endpoint.SupportedParameters

	options := map[string]string{
		"resolution":   request.Resolution,
		"aspect_ratio": request.Aspect,
		"quality":      request.Quality,
	}

	for name, value := range options {
		if value == "" || value == "auto" {
			continue
		}

		capability, present := parameters[name]
		if !present || (len(capability.Values) > 0 && !slices.Contains(capability.Values, value)) {
			return false
		}
	}

	referenceCapability := parameters["input_references"]
	if referenceCapability.Min != nil && float64(len(request.References)) < *referenceCapability.Min {
		return false
	}

	if len(request.References) > 0 {
		capability, present := parameters["input_references"]
		if !present || (capability.Max != nil && float64(len(request.References)) > *capability.Max) {
			return false
		}
	}

	return true
}

// Select one tier per billable/unit pair. A matching tier replaces the base
// rate; request fees remain additive. Unknown variants are never guessed.
func selectImagePrices(request EstimateRequest, lines []ImagePriceLine) ([]ImagePriceLine, bool) {
	selected := make(map[string]ImagePriceLine)
	scores := make(map[string]int)

	for _, line := range lines {
		score := imagePriceVariant(request, line.Variant)
		if score == -2 {
			return nil, false
		}

		if score < 0 {
			continue
		}

		key := line.Billable + "/" + line.Unit

		previous, present := scores[key]
		if !present || score > previous {
			selected[key] = line
			scores[key] = score
		}
	}

	result := make([]ImagePriceLine, 0, len(selected))
	hasOutput := false

	for _, line := range selected {
		result = append(result, line)

		if line.Billable == "output_image" && line.Unit != "request" {
			hasOutput = true
		}
	}

	// Deterministic accumulation and tooltip order.
	slices.SortFunc(result, func(left, right ImagePriceLine) int {
		return strings.Compare(left.Billable+left.Unit, right.Billable+right.Unit)
	})

	return result, hasOutput
}

func imagePriceVariant(request EstimateRequest, variant string) int {
	variant = strings.ToLower(variant)
	resolution := strings.ToLower(request.Resolution)

	quality := request.Quality
	if quality == "auto" || quality == "" {
		quality = "medium"
	}

	switch variant {
	case "":
		return 0
	case resolution, quality:
		return 1
	case quality + "_" + resolution:
		return 2
	case "style_references":
		if len(request.References) > 0 {
			return 2
		}
	case "high_resolution":
		// Seedream's 2K area tier exceeds the published 2.61M-pixel threshold.
		// https://www.volcengine.com/docs/82379/1544106
		seedreamHighResolution := request.Model == "bytedance-seed/seedream-5-0-pro" || request.Model == "bytedance-seed/seedream-5-5"
		if seedreamHighResolution && request.Resolution == "2K" {
			return 2
		}
	}

	// Known inactive tiers and optional features that Paws does not send.
	if slices.Contains([]string{"style_references", "moodboards", "high_thinking_surcharge", "high_resolution"}, variant) {
		return -1
	}

	for part := range strings.SplitSeq(variant, "_") {
		if !slices.Contains([]string{"512", "768", "1k", "1.5k", "2k", "4k", "low", "medium", "high", "xhigh", "max"}, part) {
			return -2
		}
	}

	return -1
}

// Gemini's Image API price lines omit input text and sometimes input images.
// Supplement these with the catalog's current text/image input token rate.
func supplementImagePrices(model *Model, lines []ImagePriceLine) []ImagePriceLine {
	if !strings.HasPrefix(model.ID, "google/") || model.TextInputPrice <= 0 {
		return lines
	}

	result := slices.Clone(lines)

	billables := []string{"input_text", "input_image"}

	for _, billable := range billables {
		found := false

		for _, line := range lines {
			if line.Billable == billable {
				found = true

				break
			}
		}

		if !found {
			rate := model.TextInputPrice
			result = append(result, ImagePriceLine{Billable: billable, Unit: "token", CostUSD: &rate})
		}
	}

	return result
}
