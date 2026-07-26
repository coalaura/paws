package main

import (
	"errors"
	"io"
	"sync/atomic"

	"github.com/revrost/go-openrouter"
)

type ImageGenerationStream interface {
	Recv() (openrouter.ImageGenerationStreamChunk, error)
	Close()
}

type ResponseStream struct {
	received atomic.Uint32
	chunk    openrouter.ImageGenerationStreamChunk
}

func ResponseAsStream(response openrouter.ImageGenerationResponse) (*ResponseStream, error) {
	data := response.Data

	if len(data) == 0 {
		return nil, errors.New("no content")
	}

	return &ResponseStream{
		chunk: openrouter.ImageGenerationStreamChunk{
			Type:    openrouter.ImageStreamChunkTypeCompleted,
			B64JSON: data[0].B64JSON,
			Created: response.Created,
			Usage:   response.Usage,
		},
	}, nil
}

func (s *ResponseStream) Recv() (openrouter.ImageGenerationStreamChunk, error) {
	if !s.received.CompareAndSwap(0, 1) {
		return openrouter.ImageGenerationStreamChunk{}, io.EOF
	}

	return s.chunk, nil
}

func (s *ResponseStream) Close() {
	// no-op
}
