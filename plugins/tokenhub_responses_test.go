package plugins_test

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	taskplugin "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadTokenHubPlugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("tokenhub")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "tokenhub"})
	require.NoError(t, err)
	return registry, plugin
}

func tokenHubContext(model string, metadata map[string]any) map[string]any {
	return map[string]any{
		"model":         model,
		"upstreamModel": model,
		"baseUrl":       "https://tokenhub.tencentmaas.com",
		"apiKey":        "sk-tokenhub-vendor-key",
		"upstream":      map[string]any{"kind": "vendor"},
		"requestBody":   map[string]any{"model": model, "metadata": metadata},
	}
}

// Native presenters live on the native namespace rather than at the top level.
func callTokenHubNative(t *testing.T, plugin *jsplugin.LoadedPlugin, hook string, args ...any) map[string]any {
	t.Helper()
	value, err := plugin.Engine.CallPath(t.Context(), "native", []string{hook}, args...)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, common.Unmarshal(encoded, &decoded))
	return decoded
}

func tokenHubBody(t *testing.T, ctx map[string]any) map[string]any {
	t.Helper()
	built := callHailuoHook(t, pluginForTokenHub(t), "buildSubmitRequest", ctx)
	assert.Equal(t, "https://tokenhub.tencentmaas.com/v1/api/3d/submit", built["url"])
	assert.Equal(t, "Bearer sk-tokenhub-vendor-key", alibabaObject(t, built["headers"])["Authorization"])
	return alibabaObject(t, built["body"])
}

func pluginForTokenHub(t *testing.T) *jsplugin.LoadedPlugin {
	t.Helper()
	_, plugin := loadTokenHubPlugin(t)
	return plugin
}

// Hunyuan 3D and Tripo share the TokenHub submit endpoint but bill different
// dimensions, so each model family selects its own usage profile.
func TestTokenHubSubmitAndUsage(t *testing.T) {
	plugin := pluginForTokenHub(t)
	hySchema, hyExamples := plugin.Meta.UsageForModel("hy-3d-3.1")
	hyKeys := make([]string, 0, len(hySchema))
	for key := range hySchema {
		hyKeys = append(hyKeys, key)
	}
	sort.Strings(hyKeys)
	assert.Equal(t, []string{"custom_face_count", "custom_result_format", "generate_type", "generations", "multi_view", "pbr"}, hyKeys)
	assert.Equal(t, []string{"normal", "lowpoly", "geometry", "sketch"}, hySchema["generate_type"].Enum)
	assert.NotEmpty(t, hyExamples)

	tripoSchema, tripoExamples := plugin.Meta.UsageForModel("tripo-3d-p1")
	assert.Contains(t, tripoSchema, "texture_quality")
	assert.NotContains(t, tripoSchema, "generate_type")
	assert.NotEmpty(t, tripoExamples)

	t.Run("hunyuan text to 3D defaults", func(t *testing.T) {
		body := tokenHubBody(t, tokenHubContext("hy-3d-3.1", map[string]any{"prompt": "a cat"}))
		encoded, err := common.Marshal(body)
		require.NoError(t, err)
		assert.JSONEq(t, `{"model":"hy-3d-3.1","generate_type":"Normal","prompt":"a cat"}`, string(encoded))
	})

	t.Run("hunyuan add-ons are preserved and billed", func(t *testing.T) {
		ctx := tokenHubContext("hy-3d-3.0", map[string]any{
			"prompt":            "a cat",
			"enable_pbr":        true,
			"face_count":        100000,
			"result_format":     "stl",
			"multi_view_images": []any{map[string]any{"view_type": "left", "view_image_url": "https://cdn.example/l.png"}},
		})
		body := tokenHubBody(t, ctx)
		encoded, err := common.Marshal(body)
		require.NoError(t, err)
		assert.JSONEq(t, `{"model":"hy-3d-3.0","generate_type":"Normal","prompt":"a cat","enable_pbr":true,"face_count":100000,"result_format":"stl","multi_view_images":[{"view_type":"left","view_image_url":"https://cdn.example/l.png"}]}`, string(encoded))

		facts := callHailuoHook(t, plugin, "extractUsage", ctx)
		assert.Equal(t, map[string]any{
			"generations": float64(1), "generate_type": "normal", "pbr": true, "multi_view": true,
			"custom_face_count": true, "custom_result_format": true,
		}, facts)
	})

	t.Run("geometry drops the ineffective pbr add-on", func(t *testing.T) {
		ctx := tokenHubContext("hy-3d-3.1", map[string]any{"prompt": "a cat", "generate_type": "geometry", "enable_pbr": true})
		body := tokenHubBody(t, ctx)
		_, sent := body["enable_pbr"]
		assert.False(t, sent, "geometry ignores enable_pbr upstream and must not bill it")
		facts := callHailuoHook(t, plugin, "extractUsage", ctx)
		assert.Equal(t, false, facts["pbr"])
		assert.Equal(t, "geometry", facts["generate_type"])
	})

	t.Run("tripo image to 3D", func(t *testing.T) {
		ctx := tokenHubContext("tripo-3d-3.1", map[string]any{"input": "https://cdn.example/f.png", "texture_quality": "detailed"})
		body := tokenHubBody(t, ctx)
		encoded, err := common.Marshal(body)
		require.NoError(t, err)
		assert.JSONEq(t, `{"model":"tripo-3d-3.1","input":"https://cdn.example/f.png","texture_quality":"detailed"}`, string(encoded))
		facts := callHailuoHook(t, plugin, "extractUsage", ctx)
		assert.Equal(t, map[string]any{
			"generations": float64(1), "input": "image", "texture": true, "pbr": true,
			"texture_quality": "detailed", "geometry_quality": "standard",
			"quad": false, "smart_low_poly": false, "generate_parts": false,
		}, facts)
	})

	t.Run("tripo pbr forces texture", func(t *testing.T) {
		body := tokenHubBody(t, tokenHubContext("tripo-3d-p1", map[string]any{"prompt": "a cat", "texture": false, "pbr": true}))
		assert.Equal(t, true, body["texture"])
	})
}

// Every parameter that changes the vendor's credit deduction is rejected or
// normalized before the request reaches the upstream.
func TestTokenHubRejectsOutOfContractRequests(t *testing.T) {
	plugin := pluginForTokenHub(t)
	testCases := []struct {
		name    string
		model   string
		meta    map[string]any
		wantErr string
	}{
		{"missing input", "hy-3d-3.1", map[string]any{}, "requires one of"},
		{"prompt and image together", "hy-3d-3.1", map[string]any{"prompt": "a cat", "image_url": "https://cdn.example/f.png"}, "accepts only one of"},
		{"sketch allows both", "", nil, ""},
		{"unknown generate type", "hy-3d-3.0", map[string]any{"prompt": "a cat", "generate_type": "ultra"}, "generate_type must be one of"},
		{"low poly on 3.1", "hy-3d-3.1", map[string]any{"prompt": "a cat", "generate_type": "lowpoly"}, "does not support generate_type lowpoly"},
		{"sketch on 3.1", "hy-3d-3.1", map[string]any{"prompt": "a cat", "generate_type": "sketch"}, "does not support generate_type sketch"},
		{"face count below range", "hy-3d-3.0", map[string]any{"prompt": "a cat", "face_count": 10}, "face_count must be an integer between 3000 and 1500000"},
		{"face count above range", "hy-3d-3.0", map[string]any{"prompt": "a cat", "face_count": 9000000}, "face_count must be an integer between 3000 and 1500000"},
		{"polygon type without low poly", "hy-3d-3.0", map[string]any{"prompt": "a cat", "polygon_type": "quadrilateral"}, "polygon_type requires generate_type lowpoly"},
		{"unknown result format", "hy-3d-3.0", map[string]any{"prompt": "a cat", "result_format": "gltf"}, "result_format must be one of"},
		{"tripo face limit above range", "tripo-3d-p1", map[string]any{"prompt": "a cat", "face_limit": 50000}, "face_limit must be an integer between 50 and 20000"},
		{"tripo unsupported geometry quality", "tripo-3d-p1", map[string]any{"prompt": "a cat", "geometry_quality": "detailed"}, "tripo-3d-p1 does not support geometry_quality"},
		{"tripo generate parts with texture", "tripo-3d-3.1", map[string]any{"prompt": "a cat", "generate_parts": true}, "generate_parts requires texture, pbr and quad all false"},
		{"unknown model", "hy-3d-9.9", map[string]any{"prompt": "a cat"}, "is not supported"},
	}
	for _, testCase := range testCases {
		if testCase.wantErr == "" {
			continue
		}
		t.Run(testCase.name, func(t *testing.T) {
			_, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", tokenHubContext(testCase.model, testCase.meta))
			require.Error(t, err)
			assert.Contains(t, err.Error(), testCase.wantErr)
		})
	}

	t.Run("sketch accepts prompt and image together", func(t *testing.T) {
		body := tokenHubBody(t, tokenHubContext("hy-3d-3.0", map[string]any{"prompt": "a cat", "image_url": "https://cdn.example/f.png", "generate_type": "sketch"}))
		assert.Equal(t, "Sketch", body["generate_type"])
	})
}

// The query route is a POST carrying the platform task id, and the result keeps
// every generated file as its own artifact.
func TestTokenHubQueryAndArtifacts(t *testing.T) {
	registry, plugin := loadTokenHubPlugin(t)
	binding, found := registry.Generation().LookupDeclaredRoute(http.MethodPost, "/tokenhub/v1/api/3d/query")
	require.True(t, found)
	assert.Equal(t, jsplugin.RouteTypeDynamic, binding.Route.Type)
	decoded, err := plugin.Engine.CallPath(t.Context(), "native", []string{"decodeQuery"}, map[string]any{
		"path": "/tokenhub/v1/api/3d/query", "body": map[string]any{"kind": "json", "value": map[string]any{"model": "hy-3d-3.1", "task_id": "task_public"}},
	})
	require.NoError(t, err)
	assert.Equal(t, []any{"task_public"}, alibabaObject(t, decoded)["taskIds"])

	batchedIDs, err := plugin.Engine.CallPath(t.Context(), "native", []string{"decodeQuery"}, map[string]any{
		"path": "/tokenhub/v1/api/3d/query", "body": map[string]any{"kind": "json", "value": map[string]any{"task_id": []any{"task_a", "", "task_b"}}},
	})
	require.NoError(t, err)
	assert.Equal(t, []any{"task_a", "task_b"}, alibabaObject(t, batchedIDs)["taskIds"])

	_, err = plugin.Engine.CallPath(t.Context(), "native", []string{"decodeQuery"}, map[string]any{
		"path": "/tokenhub/v1/api/3d/query", "body": map[string]any{"kind": "json", "value": map[string]any{}},
	})
	require.ErrorContains(t, err, "task_id is required")

	// The route resolves the public id; the vendor id it polls with comes from
	// the persisted task, never from the client.
	query := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "14721", "publicTaskId": "task_public", "model": "hy-3d-3.1", "upstreamModel": "hy-3d-3.1",
		"baseUrl": "https://tokenhub.tencentmaas.com", "apiKey": "tokenhub-api-key",
		"upstream": map[string]any{"kind": "vendor"},
	})
	assert.Equal(t, "https://tokenhub.tencentmaas.com/v1/api/3d/query", query["url"])
	assert.Equal(t, "POST", query["method"])
	assert.Equal(t, map[string]any{"model": "hy-3d-3.1", "id": "14721"}, alibabaObject(t, query["body"]))

	gateway := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "14721", "model": "hy-3d-3.1", "upstreamModel": "hy-3d-3.1",
		"baseUrl": "https://gateway.example", "apiKey": "sk-gateway-token",
		"upstream": map[string]any{"kind": "new_api"},
	})
	assert.Equal(t, "https://gateway.example/tokenhub/v1/api/3d/query", gateway["url"])

	// TokenHub's own keys start with sk-, so the key prefix must never be read
	// as a gateway signal: that turned every vendor call into a 404.
	vendorKey := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "14721", "model": "hy-3d-3.1", "upstreamModel": "hy-3d-3.1",
		"baseUrl": "https://tokenhub.tencentmaas.com", "apiKey": "sk-RnefVendorTokenHubKey",
		"upstream": map[string]any{"kind": "vendor"},
	})
	assert.Equal(t, "https://tokenhub.tencentmaas.com/v1/api/3d/query", vendorKey["url"])

	// A dynamic route renders the stored snapshot under the public id; one task
	// keeps the vendor's single-object envelope.
	var stored any
	require.NoError(t, common.UnmarshalJsonStr(`{"id":"14721","status":"completed","data":[{"type":"obj","url":"https://cdn.example/m.zip"},{"type":"glb","url":"https://cdn.example/m.glb"}]}`, &stored))
	single := callTokenHubNative(t, plugin, "renderQuery", map[string]any{}, map[string]any{"task_id": "task_public", "data": stored})
	assert.Equal(t, "task_public", single["id"])
	assert.Equal(t, "completed", single["status"])
	batched := callTokenHubNative(t, plugin, "renderQuery", map[string]any{}, []any{
		map[string]any{"task_id": "task_a", "data": stored},
		map[string]any{"task_id": "task_b", "data": stored},
	})
	assert.Len(t, alibabaObject(t, batched)["data"], 2)

	// A rejected submission must surface the vendor's own message instead of
	// stringifying its error object.
	_, submitErr := plugin.Engine.Call(t.Context(), "parseSubmitResponse", map[string]any{},
		map[string]any{"statusCode": 401, "body": map[string]any{"error": map[string]any{"code": "401002", "message": "API Key does not exist", "message_zh": "API Key 不存在"}}})
	require.ErrorContains(t, submitErr, "API Key 不存在")

	hunyuan := `{"id":"14721","status":"completed","data":[{"type":"obj","url":"https://cdn.example/m.zip"},{"type":"glb","url":"https://cdn.example/m.glb"}]}`
	var hunyuanBody any
	require.NoError(t, common.UnmarshalJsonStr(hunyuan, &hunyuanBody))
	assert.Equal(t, map[string]any{"code": float64(0), "taskId": "14721", "status": "SUCCESS", "reason": "", "url": "https://cdn.example/m.zip"},
		callHailuoHook(t, plugin, "parseTaskResult", map[string]any{}, hunyuanBody))

	tripo := `{"id":"14722","status":"success","output":{"type":"text_to_model","model_url":"https://cdn.example/m.glb","rendered_image_url":"https://cdn.example/p.png"}}`
	var tripoBody any
	require.NoError(t, common.UnmarshalJsonStr(tripo, &tripoBody))
	parsed := callHailuoHook(t, plugin, "parseTaskResult", map[string]any{}, tripoBody)
	assert.Equal(t, "SUCCESS", parsed["status"], "the Tripo guide documents a success status alongside the shared enum")

	// Tripo polls as processing, not in_progress; an unrecognized status makes
	// the host count poll failures and eventually fail a healthy task.
	for _, status := range []string{"processing", "in_progress", "running"} {
		var pending any
		require.NoError(t, common.UnmarshalJsonStr(`{"id":"14722","status":"`+status+`"}`, &pending))
		assert.Equal(t, "IN_PROGRESS", callHailuoHook(t, plugin, "parseTaskResult", map[string]any{}, pending)["status"], status)
	}

	failed := `{"id":"14723","status":"failed","message":"risk control"}`
	var failedBody any
	require.NoError(t, common.UnmarshalJsonStr(failed, &failedBody))
	assert.Equal(t, map[string]any{"code": float64(0), "taskId": "14723", "status": "FAILURE", "reason": "risk control"},
		callHailuoHook(t, plugin, "parseTaskResult", map[string]any{}, failedBody))

	artifacts := callArtifacts(t, plugin, map[string]any{"status": "SUCCESS", "data": hunyuanBody})
	assert.Equal(t, []any{
		map[string]any{"key": "obj", "type": "file"},
		map[string]any{"key": "glb", "type": "file"},
	}, artifacts)
	content := callHailuoHook(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey": "glb", "data": hunyuanBody, "clientRequest": map[string]any{"method": "GET"},
	})
	assert.Equal(t, "https://cdn.example/m.glb", content["url"])
	assert.Equal(t, true, content["credentialless"])
}

// The Responses surface renders one 3D model per call, so an image input maps
// onto each family's own image field.
func TestTokenHubResponsesProtocol(t *testing.T) {
	applied := false
	for _, model := range []string{"hy-3d-3.1", "tripo-3d-3.1"} {
		t.Run(model, func(t *testing.T) {
			_, plugin := loadTokenHubPlugin(t)
			value, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
				"model": model, "stream": false,
				"body": map[string]any{"kind": "json", "value": map[string]any{"model": model, "input": []any{map[string]any{"role": "user", "content": []any{
					map[string]any{"type": "input_text", "text": "a glass knight"},
					map[string]any{"type": "input_image", "image_url": "https://cdn.example/f.png"},
				}}}}},
			})
			require.NoError(t, err)
			encoded, err := common.Marshal(value)
			require.NoError(t, err)
			var decoded map[string]any
			require.NoError(t, common.Unmarshal(encoded, &decoded))
			assert.Equal(t, model, decoded["model"])
			metadata := alibabaObject(t, alibabaObject(t, decoded["requestBody"])["metadata"])
			assert.Equal(t, "a glass knight", metadata["prompt"])
			imageKey := "image_url"
			if model == "tripo-3d-3.1" {
				imageKey = "input"
			}
			assert.Equal(t, "https://cdn.example/f.png", metadata[imageKey])
			applied = true
		})
	}
	require.True(t, applied)
}

// Extra Responses images become distinct views; every image claiming the same
// view would be rejected or silently collapse upstream.
func TestTokenHubResponsesMultiView(t *testing.T) {
	_, plugin := loadTokenHubPlugin(t)
	testCases := []struct {
		model   string
		field   string
		wantOne []any
		wantTwo []any
	}{
		{
			model: "hy-3d-3.1",
			field: "multi_view_images",
			wantOne: []any{
				map[string]any{"view_type": "right", "view_image_url": "https://cdn.example/b.png"},
			},
			wantTwo: []any{
				map[string]any{"view_type": "right", "view_image_url": "https://cdn.example/b.png"},
				map[string]any{"view_type": "back", "view_image_url": "https://cdn.example/c.png"},
			},
		},
		{
			model: "tripo-3d-3.1",
			field: "inputs",
			wantOne: []any{
				map[string]any{"back": "https://cdn.example/b.png"},
			},
			wantTwo: []any{
				map[string]any{"back": "https://cdn.example/b.png"},
				map[string]any{"left": "https://cdn.example/c.png"},
			},
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.model, func(t *testing.T) {
			decode := func(images []any) map[string]any {
				content := []any{map[string]any{"type": "input_text", "text": "a glass knight"}}
				for _, image := range images {
					content = append(content, map[string]any{"type": "input_image", "image_url": image})
				}
				value, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
					"model": testCase.model, "stream": false,
					"body": map[string]any{"kind": "json", "value": map[string]any{"model": testCase.model, "input": []any{map[string]any{"role": "user", "content": content}}}},
				})
				require.NoError(t, err)
				encoded, err := common.Marshal(value)
				require.NoError(t, err)
				var decoded map[string]any
				require.NoError(t, common.Unmarshal(encoded, &decoded))
				return alibabaObject(t, alibabaObject(t, decoded["requestBody"])["metadata"])
			}

			two := decode([]any{"https://cdn.example/a.png", "https://cdn.example/b.png"})
			assert.Equal(t, testCase.wantOne, two[testCase.field])
			three := decode([]any{"https://cdn.example/a.png", "https://cdn.example/b.png", "https://cdn.example/c.png"})
			assert.Equal(t, testCase.wantTwo, three[testCase.field])
		})
	}
}

// A task plugin channel needs its model list to cover every declared model.
func TestTokenHubChannelSelection(t *testing.T) {
	_, plugin := loadTokenHubPlugin(t)
	info := &relaycommon.RelayInfo{
		ChannelMeta:     &relaycommon.ChannelMeta{ApiKey: "tokenhub-api-key", ChannelBaseUrl: "https://tokenhub.tencentmaas.com", UpstreamModelName: "hy-3d-3.1"},
		OriginModelName: "hy-3d-3.1",
		TaskRelayInfo:   &relaycommon.TaskRelayInfo{PublicTaskID: "task_public"},
	}
	adaptor := taskplugin.New(plugin)
	adaptor.Init(info)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/tokenhub/v1/api/3d/submit", nil)
	c.Set("task_request", map[string]any{"model": "hy-3d-3.1", "metadata": map[string]any{"prompt": "a cat"}})
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{
		"generations": float64(1), "generate_type": "normal", "pbr": false, "multi_view": false,
		"custom_face_count": false, "custom_result_format": false,
	}, facts)
}
