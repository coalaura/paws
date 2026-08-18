package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/coalaura/openingrouter"
)

type EstimateRequest struct {
	Model      string          `json:"model"`
	Quality    string          `json:"quality"`
	Aspect     string          `json:"aspect"`
	Resolution string          `json:"resolution"`
	References []ReferenceSize `json:"references"`
}

type ReferenceSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type EstimateResponse struct {
	Estimate float64 `json:"estimate"`
}

type imageTokenRates struct {
	ImageIn  float64
	ImageOut float64
	TextIn   float64
}

var (
	imageModelTokenRates = map[string]imageTokenRates{
		"openai/gpt-image-2":      {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-image-1":      {ImageIn: 10, ImageOut: 40, TextIn: 5},
		"openai/gpt-image-1-mini": {ImageIn: 2.5, ImageOut: 8, TextIn: 2},
		"openai/gpt-5-image":      {ImageIn: 10, ImageOut: 40, TextIn: 5},
		"openai/gpt-5-image-mini": {ImageIn: 2.5, ImageOut: 8, TextIn: 2},
	}

	gptImage2QualityAxis = map[string]int64{
		"low":    16,
		"medium": 48,
		"high":   96,
	}

	gptImage1OutputTokens = map[string]map[string]int{
		"1024x1024": {"low": 272, "medium": 1056, "high": 4160},
		"1024x1536": {"low": 408, "medium": 1584, "high": 6240},
		"1536x1024": {"low": 400, "medium": 1568, "high": 6208},
	}

	namedAspects = map[string][2]int{
		"1:1":  {1, 1},
		"16:9": {16, 9},
		"9:16": {9, 16},
		"4:3":  {4, 3},
		"3:4":  {3, 4},
		"3:2":  {3, 2},
		"2:3":  {2, 3},
		"4:5":  {4, 5},
		"5:4":  {5, 4},
		"21:9": {21, 9},
		"9:21": {9, 21},
		"2:1":  {2, 1},
		"1:2":  {1, 2},
		"3:1":  {3, 1},
		"1:3":  {1, 3},
	}
)

func HandleImageEstimate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)

		return
	}

	var req EstimateRequest

	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": "invalid json",
		})

		return
	}

	if req.Model == "" {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": "model is required",
		})

		return
	}

	estimate, err := EstimateImageCost(req)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	RespondJson(w, http.StatusOK, EstimateResponse{
		Estimate: roundUSD(estimate),
	})
}

func EstimateImageCost(req EstimateRequest) (float64, error) {
	if _, ok := imageModelTokenRates[req.Model]; ok {
		if strings.Contains(req.Model, "gpt-image-2") {
			return estimateGPTImage2(req), nil
		}

		return estimateGPTImage1Family(req), nil
	}

	return estimateFlatPriced(req), nil
}

func estimateGPTImage2(req EstimateRequest) float64 {
	rates := imageModelTokenRates[req.Model]

	width, height := resolveGPTImage2Size(req)

	quality := req.Quality

	if quality == "auto" {
		quality = "medium"
	}

	outputTokens := gptImage2OutputTokens(width, height, quality)

	var inputImageTokens int

	for _, ref := range req.References {
		if ref.Width > 0 && ref.Height > 0 {
			inputImageTokens += gptImage2ReferenceTokens(ref.Width, ref.Height)
		}
	}

	textTokens := 80 + len(req.References)

	cost := float64(outputTokens)*rates.ImageOut/1000000 + float64(inputImageTokens)*rates.ImageIn/1000000 + float64(textTokens)*rates.TextIn/1000000

	return cost
}

func estimateGPTImage1Family(req EstimateRequest) float64 {
	rates := imageModelTokenRates[req.Model]

	sizeKey := resolveGPTImage1Size(req)

	quality := req.Quality
	if quality == "auto" {
		quality = "medium"
	}

	outputTokens := gptImage1OutputTokens[sizeKey][quality]

	var inputImageTokens int

	for _, ref := range req.References {
		if ref.Width > 0 && ref.Height > 0 {
			inputImageTokens += gptImage2ReferenceTokens(ref.Width, ref.Height)
		}
	}

	textTokens := 80 + len(req.References)

	return float64(outputTokens)*rates.ImageOut/1000000 + float64(inputImageTokens)*rates.ImageIn/1000000 + float64(textTokens)*rates.TextIn/1000000
}

func estimateFlatPriced(req EstimateRequest) float64 {
	pricing := ImageModelPricing[req.Model]
	if pricing == nil {
		return 0
	}

	return pricing.forResolution(req.Resolution)
}

func (p *ImagePricing) forResolution(resolution string) float64 {
	switch resolution {
	case string(openingrouter.ImageResolution4K):
		if p.K4 > 0 {
			return p.K4
		}

		if p.K2 > 0 {
			return p.K2
		}

		return p.K1
	case string(openingrouter.ImageResolution2K):
		if p.K2 > 0 {
			return p.K2
		}

		return p.K1
	default:
		if p.K1 > 0 {
			return p.K1
		}

		if p.K2 > 0 {
			return p.K2
		}

		return p.K4
	}
}

func resolveGPTImage2Size(req EstimateRequest) (int, int) {
	rw, rh, explicit := parseAspect(req.Aspect)

	longEdge := 1024

	switch req.Resolution {
	case string(openingrouter.ImageResolution4K):
		if explicit {
			longEdge = 3840
		} else {
			longEdge = 2048
		}
	case string(openingrouter.ImageResolution2K):
		if explicit {
			longEdge = 2048
		} else {
			longEdge = 1440
		}
	}

	if !explicit {
		rw, rh, ok := aspectFromReferences(req.References)
		if ok {
			return normalizeGPTImage2Size(sizeFromLongEdge(longEdge, rw, rh))
		}

		return normalizeGPTImage2Size(sizeFromLongEdge(longEdge, 3, 4))
	}

	return normalizeGPTImage2Size(sizeFromLongEdge(longEdge, rw, rh))
}

func resolveGPTImage1Size(req EstimateRequest) string {
	rw, rh, explicit := parseAspect(req.Aspect)
	if !explicit {
		w, h, ok := aspectFromReferences(req.References)
		if ok {
			rw, rh, explicit = w, h, true
		}
	}

	if !explicit || rw == rh {
		return "1024x1024"
	}

	if rw > rh {
		return "1536x1024"
	}

	return "1024x1536"
}

func parseAspect(aspect string) (int, int, bool) {
	aspect = strings.ToLower(strings.TrimSpace(aspect))
	if aspect == "" || aspect == "auto" {
		return 0, 0, false
	}

	if pair, ok := namedAspects[aspect]; ok {
		return pair[0], pair[1], true
	}

	parts := strings.Split(aspect, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}

	w, errW := strconv.Atoi(parts[0])
	h, errH := strconv.Atoi(parts[1])

	if errW != nil || errH != nil || w <= 0 || h <= 0 {
		return 0, 0, false
	}

	return w, h, true
}

func aspectFromReferences(refs []ReferenceSize) (int, int, bool) {
	for _, ref := range refs {
		if ref.Width > 0 && ref.Height > 0 {
			return ref.Width, ref.Height, true
		}
	}

	return 0, 0, false
}

func sizeFromLongEdge(longEdge, ratioW, ratioH int) (int, int) {
	if ratioW <= 0 || ratioH <= 0 {
		return longEdge, longEdge
	}

	if ratioW >= ratioH {
		return longEdge, max(1, longEdge*ratioH/ratioW)
	}

	return max(1, longEdge*ratioW/ratioH), longEdge
}

func normalizeGPTImage2Size(width, height int) (int, int) {
	const (
		step         = 16
		minPixels    = 655_360
		maxPixels    = 8_294_400
		maxEdge      = 3_840
		maxAspectNum = 3
	)

	width = max(step, width/step*step)
	height = max(step, height/step*step)

	if width > maxEdge {
		width = maxEdge
	}

	if height > maxEdge {
		height = maxEdge
	}

	if width > maxAspectNum*height {
		width = maxAspectNum * height
		width = width / step * step
	}

	if height > maxAspectNum*width {
		height = maxAspectNum * width
		height = height / step * step
	}

	pixels := width * height

	switch {
	case pixels < minPixels:
		scale := math.Sqrt(float64(minPixels) / float64(pixels))

		width = snapUp(int(math.Ceil(float64(width)*scale)), step)
		height = snapUp(int(math.Ceil(float64(height)*scale)), step)
	case pixels > maxPixels:
		scale := math.Sqrt(float64(maxPixels) / float64(pixels))

		width = max(step, int(float64(width)*scale)/step*step)
		height = max(step, int(float64(height)*scale)/step*step)
	}

	if width > maxEdge {
		width = maxEdge
	}

	if height > maxEdge {
		height = maxEdge
	}

	return width, height
}

func gptImage2OutputTokens(width, height int, quality string) int {
	q := gptImage2QualityAxis[quality]
	if q == 0 {
		q = gptImage2QualityAxis["medium"]
	}

	w := int64(width)
	h := int64(height)

	longEdge := max(w, h)
	shortEdge := min(w, h)

	// round-half-up(q * short / long)
	shortAxis := (2*q*shortEdge + longEdge) / (2 * longEdge)

	// ceil(q * shortAxis * (2,000,000 + w*h) / 4,000,000)
	numerator := q * shortAxis * (2000000 + w*h)

	return int((numerator + 4000000 - 1) / 4000000)
}

func gptImage2ReferenceTokens(width, height int) int {
	const (
		patchSize   = 32
		patchBudget = 1536
		upscaleTo   = 1024.0
		maxUpscale  = 2.0
		maxAspect   = 3
	)

	if width <= 0 || height <= 0 {
		return 0
	}

	longEdge := max(width, height)

	scale := math.Min(maxUpscale, math.Max(1, upscaleTo/float64(longEdge)))

	effW := max(1, int(math.Floor(float64(width)*scale)))
	effH := max(1, int(math.Floor(float64(height)*scale)))

	patchW := ceilDiv(effW, patchSize)
	patchH := ceilDiv(effH, patchSize)

	canvasW := effW
	canvasH := effH

	if patchW > maxAspect*patchH {
		patchH = ceilDiv(patchW, maxAspect)

		canvasW = patchW * patchSize
		canvasH = patchH * patchSize
	} else if patchH > maxAspect*patchW {
		patchW = ceilDiv(patchH, maxAspect)

		canvasW = patchW * patchSize
		canvasH = patchH * patchSize
	}

	if patchW*patchH <= patchBudget {
		return patchW * patchH
	}

	scale = math.Sqrt(float64(patchSize*patchSize*patchBudget) / float64(canvasW*canvasH))

	x := float64(canvasW) * scale / patchSize
	y := float64(canvasH) * scale / patchSize

	newW := ceilUnit(x)
	newH := ceilUnit(y)

	if newW*newH > patchBudget {
		scale *= math.Min(math.Floor(x)/x, math.Floor(y)/y)

		newW = ceilUnit(float64(canvasW) * scale / patchSize)
		newH = ceilUnit(float64(canvasH) * scale / patchSize)
	}

	return newW * newH
}

func snapUp(v, step int) int {
	return ((v + step - 1) / step) * step
}

func ceilDiv(a, b int) int {
	return (a + b - 1) / b
}

func ceilUnit(v float64) int {
	return max(1, int(math.Ceil(v-1e-12)))
}

func roundUSD(v float64) float64 {
	return math.Round(v*10000) / 10000
}
