package plugins_test

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadWorldLabsPlugin(t *testing.T) *jsplugin.LoadedPlugin {
	t.Helper()
	source, err := builtinplugins.Source("worldlabs")
	require.NoError(t, err)
	plugin, err := jsplugin.NewRegistry().RegisterFactory(source, jsplugin.Options{Key: "worldlabs"})
	require.NoError(t, err)
	return plugin
}

func worldLabsContext(model string, body map[string]any, upstream string) map[string]any {
	return map[string]any{
		"model": model, "upstreamModel": model,
		"baseUrl": "https://api.worldlabs.ai", "apiKey": "wlt-key", "authHeader": "wlt-key",
		"upstream":    map[string]any{"kind": upstream},
		"requestBody": body,
	}
}

func worldLabsJSON(t *testing.T, raw string) map[string]any {
	t.Helper()
	var value map[string]any
	require.NoError(t, common.UnmarshalJsonStr(raw, &value))
	return value
}

// The reservation follows the vendor credit table: world generation plus a
// pano step unless the image is declared a pano, and marble-1.1-plus reserves
// its variable charge at the maximum.
func TestWorldLabsSubmitAndReservation(t *testing.T) {
	plugin := loadWorldLabsPlugin(t)
	testCases := []struct {
		name    string
		body    string
		credits float64
		action  string
	}{
		{"draft text", `{"model":"marble-1.0-draft","world_prompt":{"type":"text","text_prompt":"a forest"}}`, 230, "text_to_3d"},
		{"1.1 image", `{"model":"marble-1.1","world_prompt":{"type":"image","image_prompt":{"source":"uri","uri":"https://cdn.example/a.jpg"}}}`, 1580, "image_to_3d"},
		{"1.1 declared pano", `{"model":"marble-1.1","world_prompt":{"type":"image","is_pano":true,"image_prompt":{"source":"uri","uri":"https://cdn.example/p.jpg"}}}`, 1500, "image_to_3d"},
		{"1.1-plus multi-image", `{"model":"marble-1.1-plus","world_prompt":{"type":"multi-image","multi_image_prompt":[{"azimuth":0,"content":{"source":"uri","uri":"https://cdn.example/a.jpg"}},{"azimuth":180,"content":{"source":"data_base64","data_base64":"AAAA","extension":"png"}}]}}`, 3100, "image_to_3d"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			body := worldLabsJSON(t, testCase.body)
			ctx := worldLabsContext(body["model"].(string), body, "vendor")
			built := callHailuoHook(t, plugin, "buildSubmitRequest", ctx)
			assert.Equal(t, "https://api.worldlabs.ai/marble/v1/worlds:generate", built["url"])
			assert.Equal(t, "wlt-key", alibabaObject(t, built["headers"])["WLT-Api-Key"])
			assert.Equal(t, testCase.action, built["action"])
			assert.Equal(t, map[string]any{"credits": testCase.credits}, callHailuoHook(t, plugin, "extractUsage", ctx))
		})
	}

	t.Run("permission never reaches the operator account", func(t *testing.T) {
		body := worldLabsJSON(t, `{"model":"marble-1.1","seed":7,"display_name":"Atrium","permission":{"public":true,"allowed_writers":["someone"]},"world_prompt":{"type":"text","text_prompt":"an atrium"}}`)
		built := callHailuoHook(t, plugin, "buildSubmitRequest", worldLabsContext("marble-1.1", body, "vendor"))
		encoded, err := common.Marshal(built["body"])
		require.NoError(t, err)
		assert.JSONEq(t, `{"model":"marble-1.1","seed":7,"display_name":"Atrium","world_prompt":{"type":"text","text_prompt":"an atrium"}}`, string(encoded))
	})

	t.Run("gateway uses the prefixed route and a bearer token", func(t *testing.T) {
		body := worldLabsJSON(t, `{"model":"marble-1.1","world_prompt":{"type":"text","text_prompt":"a cave"}}`)
		ctx := worldLabsContext("marble-1.1", body, "new_api")
		ctx["baseUrl"], ctx["authHeader"] = "https://gateway.example", "Bearer sk-gateway"
		built := callHailuoHook(t, plugin, "buildSubmitRequest", ctx)
		assert.Equal(t, "https://gateway.example/worldlabs/marble/v1/worlds/generate", built["url"])
		headers := alibabaObject(t, built["headers"])
		assert.Equal(t, "Bearer sk-gateway", headers["Authorization"])
		assert.NotContains(t, headers, "WLT-Api-Key")
	})
}

func TestWorldLabsRejectsOutOfContractRequests(t *testing.T) {
	plugin := loadWorldLabsPlugin(t)
	testCases := []struct {
		name    string
		body    string
		wantErr string
	}{
		{"unknown model", `{"model":"marble-9","world_prompt":{"type":"text","text_prompt":"x"}}`, "is not supported"},
		{"text without prompt", `{"model":"marble-1.1","world_prompt":{"type":"text"}}`, "text_prompt is required"},
		{"video input", `{"model":"marble-1.1","world_prompt":{"type":"video","video_prompt":{"source":"uri","uri":"https://cdn.example/v.mp4"}}}`, "video input is not supported"},
		{"operator media asset", `{"model":"marble-1.1","world_prompt":{"type":"image","image_prompt":{"source":"media_asset","media_asset_id":"abc"}}}`, "must be uri or data_base64"},
		{"too many images", `{"model":"marble-1.1","world_prompt":{"type":"multi-image","multi_image_prompt":[{"content":{"source":"uri","uri":"https://a/1"}},{"content":{"source":"uri","uri":"https://a/2"}},{"content":{"source":"uri","uri":"https://a/3"}},{"content":{"source":"uri","uri":"https://a/4"}},{"content":{"source":"uri","uri":"https://a/5"}}]}}`, "1 to 4 images"},
		{"seed out of range", `{"model":"marble-1.1","seed":-1,"world_prompt":{"type":"text","text_prompt":"x"}}`, "seed must be an integer"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			body := worldLabsJSON(t, testCase.body)
			_, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", worldLabsContext(body["model"].(string), body, "vendor"))
			require.ErrorContains(t, err, testCase.wantErr)
		})
	}
}

// Polling maps the operation's done flag, settles to its reported credits and
// exposes every world file as an artifact under the public id.
func TestWorldLabsOperationLifecycle(t *testing.T) {
	plugin := loadWorldLabsPlugin(t)
	query := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "op-1", "model": "marble-1.1", "upstreamModel": "marble-1.1",
		"baseUrl": "https://api.worldlabs.ai", "apiKey": "wlt-key", "authHeader": "wlt-key",
		"upstream": map[string]any{"kind": "vendor"},
	})
	assert.Equal(t, "https://api.worldlabs.ai/marble/v1/operations/op-1", query["url"])
	assert.Equal(t, "GET", query["method"])

	parse := func(raw string) map[string]any {
		return callHailuoHook(t, plugin, "parseTaskResult", map[string]any{"taskId": "op-1"}, worldLabsJSON(t, raw))
	}
	assert.Equal(t, "IN_PROGRESS", parse(`{"operation_id":"op-1","done":false,"metadata":{"progress":{"status":"IN_PROGRESS"}}}`)["status"])
	assert.Equal(t, "QUEUED", parse(`{"operation_id":"op-1","done":false,"metadata":{"progress":{"status":"PENDING"}}}`)["status"])
	assert.Equal(t, "UNKNOWN", parse(`{"detail":"oops"}`)["status"])
	failed := parse(`{"operation_id":"op-1","done":true,"error":{"code":3,"message":"content policy"}}`)
	assert.Equal(t, "FAILURE", failed["status"])
	assert.Equal(t, "content policy", failed["reason"])

	done := `{"operation_id":"op-1","done":true,"error":null,"cost":{"total_credits":2464},"response":{"world_id":"w-1","assets":{
		"thumbnail_url":"https://cdn.example/t.jpg","imagery":{"pano_url":"https://cdn.example/p.jpg"},
		"splats":{"spz_urls":{"full_res":"https://cdn.example/f.spz","500k":"https://cdn.example/5.spz"}},
		"mesh":{"collider_mesh_url":"https://cdn.example/c.glb"}}}}`
	result := parse(done)
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "https://cdn.example/5.spz", result["url"])

	assert.Equal(t, map[string]any{"credits": float64(2464)}, callHailuoHook(t, plugin, "extractUsageOnComplete", map[string]any{}, result, worldLabsJSON(t, done)))
	pending, err := plugin.Engine.Call(t.Context(), "extractUsageOnComplete", map[string]any{}, map[string]any{"status": "IN_PROGRESS"}, worldLabsJSON(t, done))
	require.NoError(t, err)
	assert.Nil(t, pending)

	assert.Equal(t, []any{
		map[string]any{"key": "spz-500k", "type": "file"},
		map[string]any{"key": "spz-full_res", "type": "file"},
		map[string]any{"key": "mesh-collider", "type": "file"},
		map[string]any{"key": "pano", "type": "image"},
		map[string]any{"key": "thumbnail", "type": "image"},
	}, callArtifacts(t, plugin, map[string]any{"status": "SUCCESS", "data": worldLabsJSON(t, done)}))
	content := callHailuoHook(t, plugin, "buildContentRequest", map[string]any{
		"artifactKey": "mesh-collider", "data": worldLabsJSON(t, done), "clientRequest": map[string]any{"method": "GET"},
	})
	assert.Equal(t, "https://cdn.example/c.glb", content["url"])
	assert.Equal(t, true, content["credentialless"])

	value, err := plugin.Engine.CallPath(t.Context(), "native", []string{"renderOperation"}, map[string]any{}, map[string]any{"task_id": "task_public", "data": worldLabsJSON(t, done)})
	require.NoError(t, err)
	assert.Equal(t, "task_public", alibabaObject(t, value)["operation_id"], "operation_id is not a host-replaced field")
}

func TestWorldLabsResponsesProtocol(t *testing.T) {
	plugin := loadWorldLabsPlugin(t)
	decode := func(content []any) map[string]any {
		value, err := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_responses", "decodeRequest"}, map[string]any{
			"model": "marble-1.1", "stream": false,
			"body": map[string]any{"kind": "json", "value": map[string]any{"model": "marble-1.1", "input": []any{map[string]any{"role": "user", "content": content}}}},
		})
		require.NoError(t, err)
		return alibabaObject(t, alibabaObject(t, value)["requestBody"])["world_prompt"].(map[string]any)
	}
	text := map[string]any{"type": "input_text", "text": "a harbor"}
	image := func(uri string) map[string]any { return map[string]any{"type": "input_image", "image_url": uri} }

	assert.Equal(t, map[string]any{"type": "text", "text_prompt": "a harbor"}, decode([]any{text}))
	assert.Equal(t, "image", decode([]any{text, image("https://cdn.example/a.jpg")})["type"])
	multi := decode([]any{text, image("https://cdn.example/a.jpg"), image("https://cdn.example/b.jpg")})
	assert.Equal(t, "multi-image", multi["type"])
	assert.Equal(t, []any{
		map[string]any{"azimuth": float64(0), "content": map[string]any{"source": "uri", "uri": "https://cdn.example/a.jpg"}},
		map[string]any{"azimuth": float64(180), "content": map[string]any{"source": "uri", "uri": "https://cdn.example/b.jpg"}},
	}, multi["multi_image_prompt"])
}
