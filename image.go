package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/revrost/go-openrouter"
)

type ImageConfig struct {
	Resolution string `json:"resolution"`
	Aspect     string `json:"aspect"`
}

type ChatRequest struct {
	System string      `json:"system"`
	Prompt string      `json:"prompt"`
	Model  string      `json:"model"`
	Image  ImageConfig `json:"image"`
	Images []string    `json:"images"`
}

var (
	nativeFinishReasons = map[string]string{
		// Google / Gemini Models
		"STOP": "",

		"FINISH_REASON_UNSPECIFIED": "unknown reason",
		"MAX_TOKENS":                "token limit reached",
		"OTHER":                     "unknown reason",
		"SAFETY":                    "safety filter",
		"BLOCKLIST":                 "blocklist trigger",
		"PROHIBITED_CONTENT":        "prohibited content",
		"SPII":                      "sensitive info (PII) filter",
		"RECITATION":                "copyright/recitation filter",
		"MODEL_ARMOR":               "security filter (Model Armor)",
		"IMAGE_SAFETY":              "image safety filter",
		"IMAGE_PROHIBITED_CONTENT":  "prohibited image content",
		"IMAGE_RECITATION":          "image recitation filter",
		"IMAGE_OTHER":               "unknown image error",
		"NO_IMAGE":                  "failed to generate image",
		"MALFORMED_FUNCTION_CALL":   "invalid function call",
		"UNEXPECTED_TOOL_CALL":      "unexpected tool call",
	}
)

func (r *ChatRequest) Parse() (*openrouter.ChatCompletionRequest, error) {
	var request openrouter.ChatCompletionRequest

	model := GetModel(r.Model)
	if model == nil {
		return nil, fmt.Errorf("unknown model: %q", r.Model)
	}

	request.Model = r.Model

	request.Modalities = []openrouter.ChatCompletionModality{
		openrouter.ModalityImage,
	}

	request.ImageConfig = &openrouter.ChatCompletionImageConfig{
		ImageSize: openrouter.ImageSize1K,
	}

	switch r.Image.Resolution {
	case "2K":
		request.ImageConfig.ImageSize = openrouter.ImageSize2K
	case "4K":
		request.ImageConfig.ImageSize = openrouter.ImageSize4K
	}

	switch r.Image.Aspect {
	case "1:1":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio1x1
	case "2:3":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio2x3
	case "3:2":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio3x2
	case "3:4":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio3x4
	case "4:3":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio4x3
	case "4:5":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio4x5
	case "5:4":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio5x4
	case "9:16":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio9x16
	case "16:9":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio16x9
	case "21:9":
		request.ImageConfig.AspectRatio = openrouter.AspectRatio21x9
	}

	request.Temperature = 0.85

	if r.Prompt == "" && r.System == "" {
		return nil, errors.New("missing prompt or system")
	}

	if r.System != "" {
		request.Messages = append(request.Messages, openrouter.SystemMessage(r.System))
	}

	user := openrouter.ChatCompletionMessage{
		Role: openrouter.ChatMessageRoleUser,
	}

	for _, image := range r.Images {
		user.Content.Multi = append(user.Content.Multi, openrouter.ChatMessagePart{
			Type: openrouter.ChatMessagePartTypeImageURL,
			ImageURL: &openrouter.ChatMessageImageURL{
				URL:    image,
				Detail: openrouter.ImageURLDetailAuto,
			},
		})
	}

	if r.Prompt != "" {
		user.Content.Multi = append(user.Content.Multi, openrouter.ChatMessagePart{
			Type: openrouter.ChatMessagePartTypeText,
			Text: r.Prompt,
		})
	}

	if len(user.Content.Multi) > 0 {
		request.Messages = append(request.Messages, user)
	}

	request.Stream = true

	request.Usage = &openrouter.IncludeUsage{Include: true}

	return &request, nil
}

func ParseChatRequest(r *http.Request) (*openrouter.ChatCompletionRequest, error) {
	var raw ChatRequest

	err := json.NewDecoder(r.Body).Decode(&raw)
	if err != nil {
		return nil, err
	}

	request, err := raw.Parse()
	if err != nil {
		return nil, err
	}

	return request, nil
}

func HandleDump(w http.ResponseWriter, r *http.Request) {
	debug("parsing dump")

	request, err := ParseChatRequest(r)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	RespondJson(w, http.StatusOK, map[string]any{
		"request": request,
	})
}

func HandleImage(w http.ResponseWriter, r *http.Request) {
	debug("parsing image")

	request, err := ParseChatRequest(r)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	debug("preparing stream")

	ctx := r.Context()

	response, err := NewStream(w, ctx)
	if err != nil {
		RespondJson(w, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})

		return
	}

	debug("handling request")

	go func() {
		ticker := time.NewTicker(5 * time.Second)

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				response.WriteChunk(NewChunk(ChunkAlive, nil))
			}
		}
	}()

	dump("image.json", request)

	err = RunCompletion(ctx, response, request)
	if err != nil {
		response.WriteChunk(NewChunk(ChunkError, err))

		return
	}
}

func RunCompletion(ctx context.Context, response *Stream, request *openrouter.ChatCompletionRequest) error {
	stream, err := OpenRouterStartStream(ctx, *request)
	if err != nil {
		return fmt.Errorf("stream.start: %v", err)
	}

	defer stream.Close()

	var (
		hasContent bool
		finish     openrouter.FinishReason
		native     string
		cost       float64 = -1
	)

	for {
		chunk, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}

			return fmt.Errorf("stream.receive: %v", err)
		}

		if chunk.Usage != nil {
			debug("usage chunk: model=%q provider=%q prompt=%d completion=%d cost=%f", chunk.Model, chunk.Provider, chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, chunk.Usage.Cost)

			cost = chunk.Usage.Cost
		}

		if len(chunk.Choices) == 0 {
			continue
		}

		choice := chunk.Choices[0]
		delta := choice.Delta

		if choice.FinishReason != "" {
			finish = choice.FinishReason
		}

		if choice.NativeFinishReason != "" {
			native = choice.NativeFinishReason
		}

		for _, image := range delta.Images {
			if image.Type != openrouter.StreamImageTypeImageURL {
				continue
			}

			response.WriteChunk(NewChunk(ChunkImage, image.ImageURL.URL))

			hasContent = true
		}
	}

	if reason := GetBadStopReason(finish, native); reason != "" {
		response.WriteChunk(NewChunk(ChunkError, fmt.Errorf("stopped due to: %s", reason)))
	}

	if finish == "" && !hasContent {
		response.WriteChunk(NewChunk(ChunkError, errors.New("no content returned")))
	}

	if cost != -1 {
		response.WriteChunk(NewChunk(ChunkUsage, cost))
	}

	response.WriteChunk(NewChunk(ChunkEnd, nil))

	return nil
}

func GetBadStopReason(finish openrouter.FinishReason, native string) string {
	if finish == "" {
		return ""
	}

	switch finish {
	case openrouter.FinishReasonLength:
		return "token limit reached"
	case openrouter.FinishReasonContentFilter:
		return "content filter"
	}

	debug("finished with: %q", finish)

	if native == "" {
		return ""
	}

	mapped, ok := nativeFinishReasons[native]
	if ok {
		return mapped
	}

	debug("unknown native finish reason: %q", native)

	return ""
}
