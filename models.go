package main

import (
	"context"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/coalaura/openingrouter"
)

type ModelOptions struct {
	CanStream     bool     `json:"can_stream"`
	AspectRatios  []string `json:"aspect_ratios"`
	Qualities     []string `json:"qualities"`
	Resolutions   []string `json:"resolutions"`
	MaxReferences int      `json:"max_references"`
}

type Model struct {
	ID      string        `json:"id"`
	Created int64         `json:"created"`
	Name    string        `json:"name"`
	Pricing *ImagePricing `json:"pricing,omitempty"`
	Author  string        `json:"author,omitempty"`
	Options ModelOptions  `json:"options"`
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
	err := LoadModels()
	if err != nil {
		return err
	}

	go func() {
		ticker := time.NewTicker(time.Duration(env.Settings.RefreshInterval) * time.Minute)

		for range ticker.C {
			err := LoadModels()
			if err != nil {
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

		var options ModelOptions

		if full, ok := base[model.Slug]; ok {
			options.CanStream = full.SupportsStreaming

			for paramName, parameter := range full.SupportedParameters {
				validEnum := parameter.Type == openingrouter.ImageCapabilityTypeEnum && len(parameter.Values) > 0

				switch paramName {
				case "aspect_ratio":
					if validEnum {
						options.AspectRatios = parameter.Values
					}
				case "quality":
					if validEnum {
						options.Qualities = parameter.Values
					}
				case "resolution":
					if validEnum {
						options.Resolutions = parameter.Values
					}
				case "input_references":
					if parameter.Type == openingrouter.ImageCapabilityTypeRange && parameter.Max != nil {
						options.MaxReferences = int(*parameter.Max)
					}
				}
			}
		}

		m := &Model{
			ID:      model.Slug,
			Created: model.CreatedAt.Unix(),
			Name:    model.ShortName,
			Author:  model.Author,
			Pricing: ImageModelPricing[model.Slug],
			Options: options,
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
