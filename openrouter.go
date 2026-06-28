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

func OpenRouterStartImageStream(ctx context.Context, request openrouter.ImageGenerationRequest) (*openrouter.ImageGenerationStream, error) {
	client := OpenRouterClient()

	stream, err := client.CreateImagesStream(ctx, request)
	if err != nil {
		log.Warnln(err)

		return nil, err
	}

	return stream, nil
}

func OpenRouterListModels(ctx context.Context) (map[string]openrouter.Model, error) {
	client := OpenRouterClient()

	models, err := client.ListModels(ctx)
	if err != nil {
		return nil, err
	}

	mp := make(map[string]openrouter.Model, len(models))

	for _, model := range models {
		mp[model.ID] = model
	}

	return mp, nil
}
