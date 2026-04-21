package main

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/coalaura/openingrouter"
)

type ModelPricing struct {
	Input  float64       `json:"input"`
	Output float64       `json:"output"`
	Image  *ImagePricing `json:"image,omitempty"`
}

type Model struct {
	ID      string       `json:"id"`
	Created int64        `json:"created"`
	Name    string       `json:"name"`
	Pricing ModelPricing `json:"pricing"`
	Author  string       `json:"author,omitempty"`
}

var (
	modelMx sync.RWMutex

	ModelMap  map[string]*Model
	ModelList []*Model
)

func GetModel(name string) *Model {
	modelMx.RLock()
	defer modelMx.RUnlock()

	return ModelMap[name]
}

func StartModelUpdateLoop() error {
	if err := LoadModels(); err != nil {
		return err
	}

	go func() {
		ticker := time.NewTicker(time.Duration(env.Settings.RefreshInterval) * time.Minute)

		for range ticker.C {
			if err := LoadModels(); err != nil {
				log.Warnln(err)
			}
		}
	}()

	return nil
}

func LoadModels() error {
	log.Println("Refreshing model list...")

	base, err := OpenRouterListModels(context.Background())
	if err != nil {
		return err
	}

	list, err := openingrouter.ListFrontendModels(context.Background())
	if err != nil {
		return err
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt.After(list[j].CreatedAt.Time)
	})

	var (
		newList = make([]*Model, 0, len(list))
		newMap  = make(map[string]*Model, len(list))
	)

	for _, model := range list {
		if !slices.Contains(model.OutputModalities, "image") {
			continue
		}

		if model.Endpoint == nil {
			continue
		}

		var (
			input  float64
			output float64
		)

		if full, ok := base[model.Slug]; ok {
			input, _ = strconv.ParseFloat(full.Pricing.Prompt, 64)
			output, _ = strconv.ParseFloat(full.Pricing.Completion, 64)
		} else {
			input = model.Endpoint.Pricing.Prompt.Float64()
			output = model.Endpoint.Pricing.Completion.Float64()
		}

		m := &Model{
			ID:      model.Slug,
			Created: model.CreatedAt.Unix(),
			Name:    model.ShortName,
			Author:  model.Author,

			Pricing: ModelPricing{
				Input:  input * 1000000,
				Output: output * 1000000,
				Image:  ImageModelPricing[model.Slug],
			},
		}

		newList = append(newList, m)
		newMap[m.ID] = m
	}

	log.Printf("Loaded %d models\n", len(newList))

	modelMx.Lock()

	ModelList = newList
	ModelMap = newMap

	modelMx.Unlock()

	return nil
}

func HasModelListChanged(list []openingrouter.FrontendModel) bool {
	modelMx.RLock()
	defer modelMx.RUnlock()

	if len(list) != len(ModelList) {
		return true
	}

	for i, model := range list {
		if ModelList[i].ID != model.Slug {
			return true
		}
	}

	return false
}
