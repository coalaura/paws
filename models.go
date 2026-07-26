package main

import (
	"context"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/coalaura/openingrouter"
)

type Model struct {
	ID        string        `json:"id"`
	Created   int64         `json:"created"`
	Name      string        `json:"name"`
	Pricing   *ImagePricing `json:"pricing,omitempty"`
	Author    string        `json:"author,omitempty"`
	CanStream bool          `json:"-"`
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

		var noStreaming bool

		if full, ok := base[model.Slug]; ok {
			noStreaming = !full.SupportsStreaming
		}

		m := &Model{
			ID:        model.Slug,
			Created:   model.CreatedAt.Unix(),
			Name:      model.ShortName,
			Author:    model.Author,
			Pricing:   ImageModelPricing[model.Slug],
			CanStream: !noStreaming,
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
