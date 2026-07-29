package main

import (
	"context"
	"net/http"
	"time"

	"github.com/coalaura/openingrouter"
)

func OpenRouterClient() *openingrouter.Client {
	return openingrouter.NewClient(env.Tokens.OpenRouter,
		openingrouter.WithTitle("Paws"),
		openingrouter.WithReferer("https://github.com/coalaura/paws"),
		openingrouter.WithClient(&http.Client{
			Timeout: time.Duration(env.Settings.Timeout) * time.Second,
		}),
	)
}

func OpenRouterStartImageStream(ctx context.Context, request openingrouter.ImageGenerationRequest) (openingrouter.OpenrouterStream[openingrouter.ImageStreamEvent], error) {
	client := OpenRouterClient()

	stream, err := client.GenerateImageStream(ctx, request)
	if err != nil {
		return nil, err
	}

	return stream, nil
}

func OpenRouterListModels(ctx context.Context) (map[string]openingrouter.ImageModel, error) {
	client := OpenRouterClient()

	models, err := client.ListImageModels(ctx)
	if err != nil {
		return nil, err
	}

	mp := make(map[string]openingrouter.ImageModel, len(models))

	for _, model := range models {
		mp[model.ID] = model
	}

	return mp, nil
}
