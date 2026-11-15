package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/coalaura/openingrouter"
)

const (
	gptImage2_step        = 16
	gptImage2_minPixels   = 655_360
	gptImage2_maxPixels   = 8_294_400
	gptImage2_maxEdge     = 3_840
	gptImage2_patchSize   = 32
	gptImage2_patchBudget = 1536
	gptImage2_upscaleTo   = 1024.0
	gptImage2_maxUpscale  = 2.0
	gptImage2_maxAspect   = 3
)

type EstimateRequest struct {
	Model        string          `json:"model"`
	Prompt       string          `json:"prompt"`
	System       string          `json:"system"`
	OutputTokens *int            `json:"output_tokens,omitempty"`
	Quality      string          `json:"quality"`
	Aspect       string          `json:"aspect"`
	Resolution   string          `json:"resolution"`
	References   []ReferenceSize `json:"references"`
}

type ReferenceSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type EstimateResponse struct {
	Estimate  float64  `json:"estimate"`
	Available bool     `json:"available"`
	Maximum   float64  `json:"maximum,omitempty"`
	Source    string   `json:"source"`
	Notes     []string `json:"notes,omitempty"`
}

type imageTokenRates struct {
	ImageIn  float64
	ImageOut float64
	TextIn   float64
}

var (
	imageModelTokenRates = map[string]imageTokenRates{
		// https://openrouter.ai/api/v1/images/models/{model}/endpoints
		"openai/gpt-image-2.6-sunburst":      {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-image-2.6-flare":         {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"minimax/minimax-h3-image":           {ImageIn: 1.5, ImageOut: 3.8, TextIn: 2.3},
		"minimax/minimax-h3-image-highspeed": {ImageIn: 3, ImageOut: 7.6, TextIn: 2.3},
		"tencent/hy-world-2.1-panorama":      {ImageOut: 1.6},
		"openai/gpt-image-2":                 {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-image-2.5-sunburst":      {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-image-2.5-flare":         {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-5.4-image-2":             {ImageIn: 8, ImageOut: 30, TextIn: 5},
		"openai/gpt-image-1":                 {ImageIn: 10, ImageOut: 40, TextIn: 5},
		"openai/gpt-image-1-mini":            {ImageIn: 2.5, ImageOut: 8, TextIn: 2},
		"openai/gpt-5-image":                 {ImageIn: 10, ImageOut: 40, TextIn: 5},
		"openai/gpt-5-image-mini":            {ImageIn: 2.5, ImageOut: 8, TextIn: 2},
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

func HandleImageEstimate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)

		return
	}

	var req EstimateRequest

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

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

	RespondJson(w, http.StatusOK, estimate)
}

func EstimateImageCost(req EstimateRequest) (EstimateResponse, error) {
	model := GetModel(req.Model)
	if model == nil {
		return EstimateResponse{}, fmt.Errorf("unknown model: %q", req.Model)
	}

	if req.Quality == "" {
		req.Quality = "auto"
	}

	if req.Aspect == "" {
		req.Aspect = "auto"
	}

	if req.Resolution == "" {
		req.Resolution = "1K"

		if len(model.Options.Resolutions) > 0 {
			req.Resolution = model.Options.Resolutions[0]
		}
	}

	options := map[string]string{"resolution": req.Resolution, "quality": req.Quality, "aspect ratio": req.Aspect}

	for name, value := range options {
		var allowed []string

		switch name {
		case "resolution":
			allowed = model.Options.Resolutions
		case "quality":
			allowed = model.Options.Qualities
		case "aspect ratio":
			allowed = model.Options.AspectRatios
		}

		if value != "auto" && len(allowed) > 0 && !slices.Contains(allowed, value) {
			return EstimateResponse{}, fmt.Errorf("model does not support %s %q", name, value)
		}
	}

	if len(req.References) < model.Options.MinReferences {
		return EstimateResponse{}, fmt.Errorf("model requires at least %d reference images", model.Options.MinReferences)
	}

	if len(req.References) > model.Options.MaxReferences {
		return EstimateResponse{}, fmt.Errorf("model only supports up to %d reference images", model.Options.MaxReferences)
	}

	if req.OutputTokens != nil && (*req.OutputTokens < 0 || *req.OutputTokens > 100000000) {
		return EstimateResponse{}, fmt.Errorf("invalid output token budget")
	}

	for _, reference := range req.References {
		if reference.Width <= 0 || reference.Height <= 0 || reference.Width > 65536 || reference.Height > 65536 {
			return EstimateResponse{}, fmt.Errorf("invalid reference dimensions")
		}
	}

	// Match ChatRequest.Parse: controls absent from the model are not sent.
	if len(model.Options.Resolutions) == 0 {
		req.Resolution = ""
	}

	if len(model.Options.Qualities) == 0 {
		req.Quality = "auto"
	}

	if len(model.Options.AspectRatios) == 0 {
		req.Aspect = "auto"
	}

	return estimateModelCost(req, model), nil
}

func resolveGPTImage2Size(req EstimateRequest) (int, int) {
	rw, rh, explicit := parseAspect(req.Aspect)

	longEdge := 1024

	if rw != rh || !explicit {
		longEdge = 1536
	}

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
			rw = w
			rh = h
			explicit = true
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

	width, errW := strconv.ParseFloat(parts[0], 64)
	height, errH := strconv.ParseFloat(parts[1], 64)

	if errW != nil || errH != nil || math.IsNaN(width) || math.IsNaN(height) || width < 0.01 || height < 0.01 || width > 1000 || height > 1000 {
		return 0, 0, false
	}

	return int(math.Round(width * 100)), int(math.Round(height * 100)), true
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
	width = max(gptImage2_step, width/gptImage2_step*gptImage2_step)
	height = max(gptImage2_step, height/gptImage2_step*gptImage2_step)

	if width > gptImage2_maxEdge {
		width = gptImage2_maxEdge
	}

	if height > gptImage2_maxEdge {
		height = gptImage2_maxEdge
	}

	if width > gptImage2_maxAspect*height {
		width = gptImage2_maxAspect * height
		width = width / gptImage2_step * gptImage2_step
	}

	if height > gptImage2_maxAspect*width {
		height = gptImage2_maxAspect * width
		height = height / gptImage2_step * gptImage2_step
	}

	pixels := width * height

	switch {
	case pixels < gptImage2_minPixels:
		scale := math.Sqrt(float64(gptImage2_minPixels) / float64(pixels))

		width = snapUp(int(math.Ceil(float64(width)*scale)), gptImage2_step)
		height = snapUp(int(math.Ceil(float64(height)*scale)), gptImage2_step)
	case pixels > gptImage2_maxPixels:
		scale := math.Sqrt(float64(gptImage2_maxPixels) / float64(pixels))

		width = max(gptImage2_step, int(float64(width)*scale)/gptImage2_step*gptImage2_step)
		height = max(gptImage2_step, int(float64(height)*scale)/gptImage2_step*gptImage2_step)
	}

	if width > gptImage2_maxEdge {
		width = gptImage2_maxEdge
	}

	if height > gptImage2_maxEdge {
		height = gptImage2_maxEdge
	}

	return width, height
}

func gptImageOutputTokens(width, height int, q int64) int {
	if q == 0 {
		q = gptImage2QualityAxis["medium"]
	}

	w := int64(width)
	h := int64(height)

	longEdge := max(w, h)
	shortEdge := min(w, h)

	// Match OpenAI's published output-token calculator (ties to even).
	shortAxis := int64(math.RoundToEven(float64(q) * float64(shortEdge) / float64(longEdge)))

	// ceil(q * shortAxis * (2,000,000 + w*h) / 4,000,000)
	numerator := q * shortAxis * (2000000 + w*h)

	return int((numerator + 4000000 - 1) / 4000000)
}

func gptImage2ReferenceTokens(width, height int) int {
	if width <= 0 || height <= 0 {
		return 0
	}

	longEdge := max(width, height)

	scale := math.Min(gptImage2_maxUpscale, math.Max(1, gptImage2_upscaleTo/float64(longEdge)))

	effW := max(1, int(math.Floor(float64(width)*scale)))
	effH := max(1, int(math.Floor(float64(height)*scale)))

	patchW := ceilDiv(effW, gptImage2_patchSize)
	patchH := ceilDiv(effH, gptImage2_patchSize)

	canvasW := effW
	canvasH := effH

	if patchW > gptImage2_maxAspect*patchH {
		patchH = ceilDiv(patchW, gptImage2_maxAspect)

		canvasW = patchW * gptImage2_patchSize
		canvasH = patchH * gptImage2_patchSize
	} else if patchH > gptImage2_maxAspect*patchW {
		patchW = ceilDiv(patchH, gptImage2_maxAspect)

		canvasW = patchW * gptImage2_patchSize
		canvasH = patchH * gptImage2_patchSize
	}

	if patchW*patchH <= gptImage2_patchBudget {
		return patchW * patchH
	}

	scale = math.Sqrt(float64(gptImage2_patchSize*gptImage2_patchSize*gptImage2_patchBudget) / float64(canvasW*canvasH))

	x := float64(canvasW) * scale / gptImage2_patchSize
	y := float64(canvasH) * scale / gptImage2_patchSize

	newW := ceilUnit(x)
	newH := ceilUnit(y)

	if newW*newH > gptImage2_patchBudget {
		scale *= math.Min(math.Floor(x)/x, math.Floor(y)/y)

		newW = ceilUnit(float64(canvasW) * scale / gptImage2_patchSize)
		newH = ceilUnit(float64(canvasH) * scale / gptImage2_patchSize)
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
	return math.Round(v*1000000) / 1000000
}
