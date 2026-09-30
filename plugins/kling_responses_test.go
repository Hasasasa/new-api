package plugins_test

import (
	"net/http"
	"net/http/httptest"
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

func TestKlingResponsesProtocol(t *testing.T) {
	testVideoResponsesProtocol(t, videoResponsesTestCase{
		pluginKey: "kling",
		model:     "kling-v2-master",
		requestBody: map[string]any{
			"model": "kling-v2-master",
			"input": []any{map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "camera orbit"},
				map[string]any{"type": "input_image", "image_url": "https://cdn.example/frame.png"},
			}}},
			"seconds": 10,
			"metadata": map[string]any{
				"mode": "pro",
			},
		},
		wantAction: "image_to_video",
		wantRequest: map[string]any{
			"model":    "kling-v2-master",
			"prompt":   "camera orbit",
			"image":    "https://cdn.example/frame.png",
			"duration": float64(10),
			"metadata": map[string]any{"mode": "pro"},
		},
		wantUsageKeys:  []string{"units"},
		wantVendorName: "kling",
	})
}

func loadKlingPlugin(t *testing.T) (*jsplugin.Registry, *jsplugin.LoadedPlugin) {
	t.Helper()
	source, err := builtinplugins.Source("kling")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "kling"})
	require.NoError(t, err)
	return registry, plugin
}

func klingV3Context(action string, requestBody map[string]any) map[string]any {
	return map[string]any{
		"action":        action,
		"model":         "kling-3.0",
		"upstreamModel": "kling-3.0",
		"baseUrl":       "https://api-beijing.klingai.com",
		"apiKey":        "console-api-key",
		"upstream":      map[string]any{"kind": "vendor"},
		"requestBody":   requestBody,
	}
}

// Kling 3.0 submits to model-named paths with nested settings/options and a
// developer-console API key sent as a plain Bearer token.
func TestKlingV3BuildSubmitRequest(t *testing.T) {
	registry, plugin := loadKlingPlugin(t)
	testCases := []struct {
		name     string
		route    string
		action   string
		request  map[string]any
		wantURL  string
		wantBody string
	}{
		{
			name:   "native text-to-video body is forwarded",
			route:  "/kling/text-to-video",
			action: "text_to_video",
			request: map[string]any{
				"model":    "kling-3.0",
				"prompt":   "a girl on a train",
				"settings": map[string]any{"resolution": "4k", "aspect_ratio": "16:9", "duration": 15, "audio": "off", "multi_shot": true},
				"options":  map[string]any{"callback_url": "https://cb.example", "watermark_info": map[string]any{"enabled": false}},
			},
			wantURL: "https://api-beijing.klingai.com/text-to-video/kling-3.0",
			wantBody: `{"prompt":"a girl on a train",
				"settings":{"resolution":"4k","aspect_ratio":"16:9","duration":15,"audio":"off","multi_shot":true},
				"options":{"callback_url":"https://cb.example","watermark_info":{"enabled":false}}}`,
		},
		{
			name:   "native image-to-video contents are forwarded without aspect ratio",
			route:  "/kling/image-to-video",
			action: "image_to_video",
			request: map[string]any{
				"model": "kling-3.0",
				"contents": []any{
					map[string]any{"type": "prompt", "text": "wave"},
					map[string]any{"type": "first_frame", "url": "https://cdn.example/first.png"},
					map[string]any{"type": "last_frame", "url": "https://cdn.example/last.png"},
				},
				"settings": map[string]any{"resolution": "1080p", "duration": 10, "audio": "native", "aspect_ratio": "1:1"},
			},
			wantURL: "https://api-beijing.klingai.com/image-to-video/kling-3.0",
			wantBody: `{"contents":[
				{"type":"prompt","text":"wave"},
				{"type":"first_frame","url":"https://cdn.example/first.png"},
				{"type":"last_frame","url":"https://cdn.example/last.png"}],
				"settings":{"resolution":"1080p","duration":10,"audio":"native"}}`,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			binding, found := registry.Generation().LookupDeclaredRoute(http.MethodPost, testCase.route)
			require.True(t, found)
			assert.Equal(t, testCase.action, binding.Route.Action)
			decoded, err := plugin.Engine.CallPath(t.Context(), "native", []string{binding.Route.Decode}, map[string]any{
				"path": testCase.route, "body": map[string]any{"kind": "json", "value": testCase.request},
			})
			require.NoError(t, err)
			submit := alibabaObject(t, decoded)
			assert.Equal(t, "kling-3.0", submit["model"])

			built := callHailuoHook(t, plugin, "buildSubmitRequest", klingV3Context(testCase.action, alibabaObject(t, submit["requestBody"])))
			assert.Equal(t, testCase.wantURL, built["url"])
			assert.Equal(t, testCase.action, built["action"])
			assert.Equal(t, "Bearer console-api-key", alibabaObject(t, built["headers"])["Authorization"])
			encoded, err := common.Marshal(built["body"])
			require.NoError(t, err)
			assert.JSONEq(t, testCase.wantBody, string(encoded))
		})
	}

	t.Run("OpenAI-style request folds flat fields into settings and contents", func(t *testing.T) {
		built := callHailuoHook(t, plugin, "buildSubmitRequest", klingV3Context("image_to_video", map[string]any{
			"model": "kling-3.0", "prompt": "orbit", "duration": 8, "mode": "std",
			"image":    map[string]any{"__fileRef": "request_file:input_reference", "encoding": "base64", "maxBytes": 10485760},
			"metadata": map[string]any{"image_tail": "https://cdn.example/last.png", "resolution": "1080P", "audio": "native", "external_task_id": "ext-1"},
		}))
		assert.Equal(t, "https://api-beijing.klingai.com/image-to-video/kling-3.0", built["url"])
		encoded, err := common.Marshal(built["body"])
		require.NoError(t, err)
		assert.JSONEq(t, `{"contents":[
			{"type":"prompt","text":"orbit"},
			{"type":"first_frame","url":{"__fileRef":"request_file:input_reference","encoding":"base64","maxBytes":10485760}},
			{"type":"last_frame","url":"https://cdn.example/last.png"}],
			"settings":{"duration":8,"resolution":"1080p","audio":"native"},
			"options":{"external_task_id":"ext-1"}}`, string(encoded))
	})

	t.Run("gateway upstream uses the unified route with the model in the body", func(t *testing.T) {
		ctx := klingV3Context("text_to_video", map[string]any{"prompt": "p"})
		ctx["upstream"] = map[string]any{"kind": "new_api"}
		ctx["baseUrl"] = "https://gateway.example"
		built := callHailuoHook(t, plugin, "buildSubmitRequest", ctx)
		assert.Equal(t, "https://gateway.example/kling/text-to-video", built["url"])
		assert.Equal(t, "kling-3.0", alibabaObject(t, built["body"])["model"])
	})
}

// duration, resolution and audio multiply the price, so out-of-contract values
// are rejected before billing.
func TestKlingV3RejectsOutOfContractSettings(t *testing.T) {
	_, plugin := loadKlingPlugin(t)
	testCases := []struct {
		name    string
		action  string
		request map[string]any
		wantErr string
	}{
		{"duration above maximum", "text_to_video", map[string]any{"prompt": "p", "metadata": map[string]any{"settings": map[string]any{"duration": 16}}}, "duration must be an integer between 3 and 15"},
		{"duration below minimum", "text_to_video", map[string]any{"prompt": "p", "duration": 2}, "duration must be an integer between 3 and 15"},
		{"fractional duration", "text_to_video", map[string]any{"prompt": "p", "duration": 5.5}, "duration must be an integer between 3 and 15"},
		{"unknown resolution", "text_to_video", map[string]any{"prompt": "p", "metadata": map[string]any{"settings": map[string]any{"resolution": "8k"}}}, "resolution must be one of"},
		{"unknown audio", "text_to_video", map[string]any{"prompt": "p", "metadata": map[string]any{"audio": "on"}}, "audio must be native or off"},
		{"missing prompt", "text_to_video", map[string]any{}, "requires a prompt"},
		{"missing first frame", "image_to_video", map[string]any{"metadata": map[string]any{"contents": []any{map[string]any{"type": "prompt", "text": "p"}}}}, "requires a first_frame content"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", klingV3Context(testCase.action, testCase.request))
			require.Error(t, err)
			assert.Contains(t, err.Error(), testCase.wantErr)
		})
	}
}

// Kling 3.0 selects its own usage profile and bills requested seconds by
// resolution and native audio; legacy models keep credit units.
func TestKlingV3UsageFacts(t *testing.T) {
	_, plugin := loadKlingPlugin(t)
	schema, examples := plugin.Meta.UsageForModel("kling-3.0")
	assert.ElementsMatch(t, []string{"seconds", "resolution", "native_audio"}, keysOf(schema))
	assert.Equal(t, []string{"720p", "1080p", "4k"}, schema["resolution"].Enum)
	assert.NotEmpty(t, examples)
	legacySchema, _ := plugin.Meta.UsageForModel("kling-v1")
	assert.Equal(t, []string{"units"}, keysOf(legacySchema))

	info := &relaycommon.RelayInfo{
		ChannelMeta:     &relaycommon.ChannelMeta{ApiKey: "console-api-key", ChannelBaseUrl: "https://api-beijing.klingai.com", UpstreamModelName: "kling-3.0"},
		OriginModelName: "kling-3.0",
		TaskRelayInfo:   &relaycommon.TaskRelayInfo{PublicTaskID: "task_public", Action: "text_to_video"},
	}
	adaptor := taskplugin.New(plugin)
	adaptor.Init(info)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/kling/text-to-video", nil)
	c.Set("task_request", map[string]any{"model": "kling-3.0", "prompt": "p", "metadata": map[string]any{
		"settings": map[string]any{"duration": 10, "resolution": "1080p", "audio": "native"},
	}})
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"seconds": float64(10), "resolution": "1080p", "native_audio": true}, facts)
}

// Kling 3.0 Turbo shares the 3.0 contract on its own model-named paths but has
// no 4k, native audio, multi_shot or last frame.
func TestKlingV3TurboSubmitAndUsage(t *testing.T) {
	registry, plugin := loadKlingPlugin(t)
	turboContext := func(action string, requestBody map[string]any) map[string]any {
		ctx := klingV3Context(action, requestBody)
		ctx["model"], ctx["upstreamModel"] = "kling-3.0-turbo", "kling-3.0-turbo"
		return ctx
	}

	for _, route := range []string{"/kling/text-to-video", "/kling/image-to-video"} {
		binding, found := registry.Generation().LookupDeclaredRoute(http.MethodPost, route)
		require.True(t, found, route)
		decoded, err := plugin.Engine.CallPath(t.Context(), "native", []string{binding.Route.Decode}, map[string]any{
			"path": route, "body": map[string]any{"kind": "json", "value": map[string]any{"model": "kling-3.0-turbo", "prompt": "p"}},
		})
		require.NoError(t, err)
		assert.Equal(t, "kling-3.0-turbo", alibabaObject(t, decoded)["model"])
	}

	built := callHailuoHook(t, plugin, "buildSubmitRequest", turboContext("image_to_video", map[string]any{
		"metadata": map[string]any{
			"contents": []any{
				map[string]any{"type": "prompt", "text": "wave"},
				map[string]any{"type": "first_frame", "url": "https://cdn.example/first.png"},
			},
			"settings": map[string]any{"resolution": "1080p", "duration": 10},
			"options":  map[string]any{"watermark_info": map[string]any{"enabled": true}},
		},
	}))
	assert.Equal(t, "https://api-beijing.klingai.com/image-to-video/kling-3.0-turbo", built["url"])
	encoded, err := common.Marshal(built["body"])
	require.NoError(t, err)
	assert.JSONEq(t, `{"contents":[
		{"type":"prompt","text":"wave"},
		{"type":"first_frame","url":"https://cdn.example/first.png"}],
		"settings":{"resolution":"1080p","duration":10},
		"options":{"watermark_info":{"enabled":true}}}`, string(encoded))

	for name, request := range map[string]map[string]any{
		"resolution must be one of":     {"prompt": "p", "metadata": map[string]any{"settings": map[string]any{"resolution": "4k"}}},
		"does not support native audio": {"prompt": "p", "metadata": map[string]any{"audio": "native"}},
		"does not support multi_shot":   {"prompt": "p", "metadata": map[string]any{"multi_shot": true}},
		"does not support last_frame":   {"image": "https://cdn.example/f.png", "metadata": map[string]any{"image_tail": "https://cdn.example/l.png"}},
	} {
		action := "text_to_video"
		if request["image"] != nil {
			action = "image_to_video"
		}
		_, err := plugin.Engine.Call(t.Context(), "buildSubmitRequest", turboContext(action, request))
		require.Error(t, err, name)
		assert.Contains(t, err.Error(), name)
	}

	schema, examples := plugin.Meta.UsageForModel("kling-3.0-turbo")
	assert.ElementsMatch(t, []string{"seconds", "resolution"}, keysOf(schema))
	assert.Equal(t, []string{"720p", "1080p"}, schema["resolution"].Enum)
	assert.NotEmpty(t, examples)
	facts := callHailuoHook(t, plugin, "extractUsage", turboContext("text_to_video", map[string]any{
		"model": "kling-3.0-turbo", "prompt": "p", "metadata": map[string]any{"settings": map[string]any{"duration": 7, "resolution": "1080p"}},
	}))
	assert.Equal(t, map[string]any{"seconds": float64(7), "resolution": "1080p"}, facts)
}

// The model-agnostic 3.x routes read the model from the body and reuse the
// model-named upstream path.
func TestKlingV3BodyModelRoutes(t *testing.T) {
	registry, plugin := loadKlingPlugin(t)
	decode := func(route string, body map[string]any) (map[string]any, error) {
		binding, found := registry.Generation().LookupDeclaredRoute(http.MethodPost, route)
		require.True(t, found, route)
		decoded, err := plugin.Engine.CallPath(t.Context(), "native", []string{binding.Route.Decode}, map[string]any{
			"path": route, "body": map[string]any{"kind": "json", "value": body},
		})
		if err != nil {
			return nil, err
		}
		return alibabaObject(t, decoded), nil
	}

	submit, err := decode("/kling/text-to-video", map[string]any{
		"model": "kling-3.0-turbo", "prompt": "p", "settings": map[string]any{"duration": 3, "aspect_ratio": "9:16"},
	})
	require.NoError(t, err)
	assert.Equal(t, "kling-3.0-turbo", submit["model"])
	ctx := klingV3Context("text_to_video", alibabaObject(t, submit["requestBody"]))
	ctx["model"], ctx["upstreamModel"] = "kling-3.0-turbo", "kling-3.0-turbo"
	built := callHailuoHook(t, plugin, "buildSubmitRequest", ctx)
	assert.Equal(t, "https://api-beijing.klingai.com/text-to-video/kling-3.0-turbo", built["url"])
	encoded, err := common.Marshal(built["body"])
	require.NoError(t, err)
	assert.JSONEq(t, `{"prompt":"p","settings":{"duration":3,"resolution":"720p","aspect_ratio":"9:16"}}`, string(encoded))

	submit, err = decode("/kling/image-to-video", map[string]any{
		"model_name": "kling-3.0",
		"contents":   []any{map[string]any{"type": "first_frame", "url": "https://cdn.example/f.png"}},
	})
	require.NoError(t, err)
	assert.Equal(t, "kling-3.0", submit["model"])

	_, err = decode("/kling/text-to-video", map[string]any{"prompt": "p"})
	require.ErrorContains(t, err, "model is required")
	_, err = decode("/kling/text-to-video", map[string]any{"model": "kling-v1", "prompt": "p"})
	require.ErrorContains(t, err, "is not supported on this route")
}

func TestKlingV3QueryAndResult(t *testing.T) {
	_, plugin := loadKlingPlugin(t)

	query := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "860", "model": "kling-3.0", "upstreamModel": "kling-3.0", "action": "text_to_video",
		"baseUrl": "https://api-beijing.klingai.com", "apiKey": "console-api-key", "upstream": map[string]any{"kind": "vendor"},
	})
	assert.Equal(t, "https://api-beijing.klingai.com/tasks?task_ids=860", query["url"])
	assert.Equal(t, "Bearer console-api-key", alibabaObject(t, query["headers"])["Authorization"])

	gatewayQuery := callHailuoHook(t, plugin, "buildQueryRequest", map[string]any{
		"taskId": "task_x", "model": "kling-3.0", "upstreamModel": "kling-3.0", "action": "text_to_video",
		"baseUrl": "https://gateway.example", "apiKey": "sk-relay", "upstream": map[string]any{"kind": "new_api"},
	})
	assert.Equal(t, "https://gateway.example/kling/tasks/task_x", gatewayQuery["url"])

	testCases := []struct {
		name string
		body string
		want map[string]any
	}{
		{
			name: "succeeded task exposes the video url",
			body: `{"code":0,"data":[{"id":"860","status":"succeeded","outputs":[{"type":"video","url":"https://cdn.example/v.mp4","duration":"5"}],"billing":[{"amount":"4"}]}]}`,
			want: map[string]any{"code": float64(0), "taskId": "860", "status": "SUCCESS", "reason": "", "url": "https://cdn.example/v.mp4"},
		},
		{
			name: "failed task carries the upstream message",
			body: `{"code":0,"data":[{"id":"860","status":"failed","message":"risk control"}]}`,
			want: map[string]any{"code": float64(0), "taskId": "860", "status": "FAILURE", "reason": "risk control"},
		},
		{
			name: "processing task",
			body: `{"code":0,"data":[{"id":"860","status":"processing"}]}`,
			want: map[string]any{"code": float64(0), "taskId": "860", "status": "IN_PROGRESS", "reason": ""},
		},
		{
			name: "empty task list is unrecognized",
			body: `{"code":0,"data":[]}`,
			want: map[string]any{"status": "UNKNOWN", "reason": "task not found"},
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			var body any
			require.NoError(t, common.UnmarshalJsonStr(testCase.body, &body))
			assert.Equal(t, testCase.want, callHailuoHook(t, plugin, "parseTaskResult", map[string]any{}, body))
		})
	}

	t.Run("completion keeps the requested billing facts", func(t *testing.T) {
		var body any
		require.NoError(t, common.UnmarshalJsonStr(`{"code":0,"data":[{"id":"860","status":"succeeded","billing":[{"amount":"4"}]}]}`, &body))
		value, err := plugin.Engine.Call(t.Context(), "extractUsageOnComplete", nil, nil, body)
		require.NoError(t, err)
		assert.Nil(t, value)
	})
}

// Native Kling 3.0 clients see the public task id in `id`, keeping the
// upstream create object and query list shapes.
func TestKlingV3NativeRender(t *testing.T) {
	_, plugin := loadKlingPlugin(t)
	var created any
	require.NoError(t, common.UnmarshalJsonStr(`{"code":0,"message":"ok","data":{"id":"860","status":"submitted"}}`, &created))
	createdValue, err := plugin.Engine.CallPath(t.Context(), "native", []string{"taskCreated"}, map[string]any{}, map[string]any{"task_id": "task_public", "data": created})
	require.NoError(t, err)
	encoded, err := common.Marshal(createdValue)
	require.NoError(t, err)
	assert.JSONEq(t, `{"code":0,"message":"ok","data":{"id":"task_public","status":"submitted"}}`, string(encoded))

	var polled any
	require.NoError(t, common.UnmarshalJsonStr(`{"code":0,"data":[{"id":"860","status":"succeeded","outputs":[{"type":"video","url":"https://cdn.example/v.mp4"}]}]}`, &polled))
	statusValue, err := plugin.Engine.CallPath(t.Context(), "native", []string{"taskStatus"}, map[string]any{}, map[string]any{"task_id": "task_public", "data": polled})
	require.NoError(t, err)
	encoded, err = common.Marshal(statusValue)
	require.NoError(t, err)
	assert.JSONEq(t, `{"code":0,"data":[{"id":"task_public","status":"succeeded","outputs":[{"type":"video","url":"https://cdn.example/v.mp4"}]}]}`, string(encoded))

	artifacts := callArtifacts(t, plugin, map[string]any{"status": "SUCCESS", "data": polled})
	assert.Equal(t, []any{map[string]any{"key": "video", "type": "video"}}, artifacts)
}

func callArtifacts(t *testing.T, plugin *jsplugin.LoadedPlugin, task map[string]any) []any {
	t.Helper()
	value, err := plugin.Engine.Call(t.Context(), "listArtifacts", task)
	require.NoError(t, err)
	encoded, err := common.Marshal(value)
	require.NoError(t, err)
	var decoded []any
	require.NoError(t, common.Unmarshal(encoded, &decoded))
	return decoded
}
