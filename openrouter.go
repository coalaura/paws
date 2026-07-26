package main

import (
	"context"
	"net/http"
	"time"

	"github.com/revrost/go-openrouter"
)

func init() {
	openrouter.DisableLogs()
}

func OpenRouterClient() *openrouter.Client {
	cc := openrouter.DefaultConfig(env.Tokens.OpenRouter)

	cc.XTitle = "Paws"
	cc.HttpReferer = "https://github.com/coalaura/paws"

	cc.HTTPClient = &http.Client{
		Timeout: time.Duration(env.Settings.Timeout) * time.Second,
	}

	return openrouter.NewClientWithConfig(*cc)
}

func OpenRouterStartImageStream(ctx context.Context, request openrouter.ImageGenerationRequest) (ImageGenerationStream, error) {
	client := OpenRouterClient()

	if request.Stream != nil && !*request.Stream {
		resp, err := client.CreateImages(ctx, request)
		if err != nil {
			return nil, err
		}

		return ResponseAsStream(resp)
	}

	stream, err := client.CreateImagesStream(ctx, request)
	if err != nil {
		return nil, err
	}

	return stream, nil
}

func OpenRouterListModels(ctx context.Context) (map[string]openrouter.ImageModel, error) {
	client := OpenRouterClient()

	models, err := client.ListImageModels(ctx)
	if err != nil {
		return nil, err
	}

	mp := make(map[string]openrouter.ImageModel, len(models))

	for _, model := range models {
		mp[model.ID] = model
	}

	return mp, nil
}
