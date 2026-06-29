package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
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

func (r *ChatRequest) Parse() (*openrouter.ImageGenerationRequest, error) {
	var request openrouter.ImageGenerationRequest

	model := GetModel(r.Model)
	if model == nil {
		return nil, fmt.Errorf("unknown model: %q", r.Model)
	}

	request.Model = r.Model

	prompt := r.Prompt

	if r.System != "" {
		if prompt != "" {
			prompt = r.System + "\n\n" + prompt
		} else {
			prompt = r.System
		}
	}

	if prompt == "" {
		return nil, errors.New("missing prompt or system")
	}

	request.Prompt = prompt

	switch r.Image.Resolution {
	case "512":
		request.Resolution = openrouter.ImageResolution512
	case "2K":
		request.Resolution = openrouter.ImageResolution2K
	case "4K":
		request.Resolution = openrouter.ImageResolution4K
	default:
		request.Resolution = openrouter.ImageResolution1K
	}

	switch r.Image.Aspect {
	case "1:1":
		request.AspectRatio = openrouter.ImageAspectRatio1x1
	case "1:2":
		request.AspectRatio = openrouter.ImageAspectRatio1x2
	case "1:4":
		request.AspectRatio = openrouter.ImageAspectRatio1x4
	case "1:8":
		request.AspectRatio = openrouter.ImageAspectRatio1x8
	case "2:1":
		request.AspectRatio = openrouter.ImageAspectRatio2x1
	case "2:3":
		request.AspectRatio = openrouter.ImageAspectRatio2x3
	case "3:2":
		request.AspectRatio = openrouter.ImageAspectRatio3x2
	case "3:4":
		request.AspectRatio = openrouter.ImageAspectRatio3x4
	case "4:1":
		request.AspectRatio = openrouter.ImageAspectRatio4x1
	case "4:3":
		request.AspectRatio = openrouter.ImageAspectRatio4x3
	case "4:5":
		request.AspectRatio = openrouter.ImageAspectRatio4x5
	case "5:4":
		request.AspectRatio = openrouter.ImageAspectRatio5x4
	case "8:1":
		request.AspectRatio = openrouter.ImageAspectRatio8x1
	case "9:16":
		request.AspectRatio = openrouter.ImageAspectRatio9x16
	case "16:9":
		request.AspectRatio = openrouter.ImageAspectRatio16x9
	case "21:9":
		request.AspectRatio = openrouter.ImageAspectRatio21x9
	default:
		// don't set aspect ratio
	}

	for _, img := range r.Images {
		request.InputReferences = append(request.InputReferences, openrouter.ImageInputReference{
			Type: openrouter.ImageInputReferenceTypeImageURL,
			ImageURL: openrouter.ImageURLRef{
				URL: img,
			},
		})
	}

	streamEnabled := true
	request.Stream = &streamEnabled

	return &request, nil
}

func ParseChatRequest(r *http.Request) (*openrouter.ImageGenerationRequest, error) {
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

func RunCompletion(ctx context.Context, response *Stream, request *openrouter.ImageGenerationRequest) error {
	stream, err := OpenRouterStartImageStream(ctx, *request)
	if err != nil {
		return fmt.Errorf("stream.start: %v", err)
	}

	defer stream.Close()

	var (
		hasContent bool
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
			debug("usage chunk: prompt=%d completion=%d cost=%v", chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens, chunk.Usage.Cost)

			if chunk.Usage.Cost != nil {
				cost = *chunk.Usage.Cost
			}
		}

		if chunk.B64JSON != "" {
			imageURL := chunk.B64JSON
			if !strings.HasPrefix(imageURL, "data:") {
				mimeType := mimeTypeFromBase64(chunk.B64JSON)

				imageURL = "data:" + mimeType + ";base64," + chunk.B64JSON
			}

			response.WriteChunk(NewChunk(ChunkImage, imageURL))

			hasContent = true
		}
	}

	if !hasContent {
		response.WriteChunk(NewChunk(ChunkError, errors.New("no content returned")))
	}

	if cost != -1 {
		response.WriteChunk(NewChunk(ChunkUsage, cost))
	}

	response.WriteChunk(NewChunk(ChunkEnd, nil))

	return nil
}

func mimeTypeFromBase64(b64 string) string {
	if len(b64) < 4 {
		return "image/png"
	}

	limit := 32
	if len(b64) < limit {
		limit = (len(b64) / 4) * 4
	}

	if limit == 0 {
		return "image/png"
	}

	prefix := b64[:limit]

	dec := make([]byte, base64.RawStdEncoding.DecodedLen(len(prefix)))

	n, err := base64.RawStdEncoding.Decode(dec, []byte(prefix))
	if err != nil {
		dec = make([]byte, base64.StdEncoding.DecodedLen(len(prefix)))

		n, err = base64.StdEncoding.Decode(dec, []byte(prefix))
		if err != nil {
			return "image/png"
		}
	}

	dec = dec[:n]

	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if bytes.HasPrefix(dec, []byte("\x89PNG\r\n\x1a\n")) {
		return "image/png"
	}

	// JPEG: FF D8 FF
	if bytes.HasPrefix(dec, []byte("\xff\xd8\xff")) {
		return "image/jpeg"
	}

	// WebP: RIFFxxxxWEBP
	if len(dec) >= 12 && bytes.HasPrefix(dec, []byte("RIFF")) && bytes.Equal(dec[8:12], []byte("WEBP")) {
		return "image/webp"
	}

	// SVG: check for common tags
	str := strings.TrimSpace(string(dec))
	if strings.HasPrefix(str, "<svg") || strings.HasPrefix(str, "<?xml") || strings.Contains(strings.ToLower(str), "<svg") {
		return "image/svg+xml"
	}

	return "image/png"
}
