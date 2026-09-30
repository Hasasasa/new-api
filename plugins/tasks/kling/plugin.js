// Kling 3.0 bills per output second by resolution and native audio.
const V3_USAGE_SCHEMA = {
  seconds: {
    type: "number",
    unit: "second",
    description: { en: "Video generation unit price", zh: "视频生成单价" },
  },
  resolution: {
    enum: ["720p", "1080p", "4k"],
    description: { en: "Output video resolution", zh: "输出视频分辨率" },
  },
  // Named apart from the request's settings.audio string, which the host
  // validates against any usage fact sharing its key.
  native_audio: {
    type: "boolean",
    description: { en: "Whether native audio is generated", zh: "是否生成原生音频" },
  },
};

// Kling 3.0 Turbo has no 4k and no native audio, so it bills by seconds and resolution only.
const V3_TURBO_USAGE_SCHEMA = {
  seconds: V3_USAGE_SCHEMA.seconds,
  resolution: {
    enum: ["720p", "1080p"],
    description: V3_USAGE_SCHEMA.resolution.description,
  },
};

export const meta = {
  apiVersion: 1,
  key: "kling",
  name: "Kling",
  icon: "Kling.Color",
  description: {
    en: "Kuaishou Kling video generation (text-to-video and image-to-video)",
    zh: "快手可灵视频生成（文生视频、图生视频）",
  },
  version: "1.2.0",
  author: { name: "QuantumNous" },
  channelTypes: [50],
  models: ["kling-v1", "kling-v1-6", "kling-v2-master", "kling-3.0", "kling-3.0-turbo"],
  fetchMode: "per_task",
  upstreams: ["vendor", "new_api"],
  usageSchema: {
    // Kling final unit deduction (estimated at submit, actual on completion).
    units: {
      type: "number",
      unit: "credit",
      description: { en: "Kling credit unit price", zh: "可灵资源包单位单价" },
    },
  },
  usageExamples: [
    { label: "v1 std 5s", facts: { units: 1 } },
    { label: "v1 pro 5s", facts: { units: 3.5 } },
    { label: "v1-6 std 5s", facts: { units: 2 } },
    { label: "v1-6 pro 10s", facts: { units: 7 } },
    { label: "v2-master pro 5s", facts: { units: 10 } },
  ],
  usageProfiles: [
    {
      models: ["kling-3.0"],
      schema: V3_USAGE_SCHEMA,
      examples: [
        { label: "3.0 720p 5s", facts: { seconds: 5, resolution: "720p", native_audio: false } },
        { label: "3.0 1080p 5s · audio", facts: { seconds: 5, resolution: "1080p", native_audio: true } },
        { label: "3.0 4k 15s", facts: { seconds: 15, resolution: "4k", native_audio: false } },
      ],
    },
    {
      models: ["kling-3.0-turbo"],
      schema: V3_TURBO_USAGE_SCHEMA,
      examples: [
        { label: "3.0 turbo 720p 5s", facts: { seconds: 5, resolution: "720p" } },
        { label: "3.0 turbo 1080p 10s", facts: { seconds: 10, resolution: "1080p" } },
      ],
    },
  ],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }, "openai_video"],
  routes: [
    { method: "POST", path: "/kling/v1/videos/text2video", type: "submit", action: "text_to_video", decode: "decodeSubmit", render: "taskCreated" },
    { method: "POST", path: "/kling/v1/videos/image2video", type: "submit", action: "image_to_video", decode: "decodeSubmit", render: "taskCreated" },
    { method: "GET", path: "/kling/v1/videos/text2video/:task_id", type: "query", render: "taskStatus" },
    { method: "GET", path: "/kling/v1/videos/image2video/:task_id", type: "query", render: "taskStatus" },
    // Model-agnostic 3.x routes: the model travels in the body as model or model_name.
    { method: "POST", path: "/kling/text-to-video", type: "submit", action: "text_to_video", decode: "decodeV3BodySubmit", render: "taskCreated" },
    { method: "POST", path: "/kling/image-to-video", type: "submit", action: "image_to_video", decode: "decodeV3BodySubmit", render: "taskCreated" },
    { method: "GET", path: "/kling/tasks/:task_id", type: "query", render: "taskStatus" },
  ],
};

// Official unit consumption (units per output video second), not a currency price.
// Source: https://kling.ai/dev/pricing
const UNITS_PER_SECOND = {
  "kling-v1": { std: 0.2, pro: 0.7 },
  "kling-v1-6": { std: 0.4, pro: 0.7 },
  "kling-v2-master": { pro: 2.0 },
};

function trimmed(value) {
  return String(value || "").trim();
}

function responsesInput(req) {
  const texts = [],
    images = [];
  const input = req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }
  return {
    prompt: texts
      .filter(function (text) {
        return trimmed(text);
      })
      .join("\n"),
    images: images,
  };
}

function responsesVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

function isRelay(apiKey) {
  return apiKey.startsWith("sk-");
}

// The host signal is authoritative on New API channels; the sk- key prefix
// stays as the heuristic for legacy type-50 channels pointed at a gateway.
function viaGateway(ctx) {
  return !!(ctx.upstream && ctx.upstream.kind === "new_api") || isRelay(ctx.apiKey);
}

function tokenFor(ctx) {
  if (viaGateway(ctx)) return ctx.apiKey;
  // Developer-console API keys are sent as-is; accessKey|secretKey pairs are signed.
  if (!ctx.apiKey.includes("|")) return ctx.apiKey.trim();
  const parts = ctx.apiKey.split("|");
  if (parts.length !== 2) throw new Error("invalid api_key, required format is accessKey|secretKey");
  const now = utils.unixNow();
  return utils.jwtSignHS256({ iss: parts[0].trim(), exp: now + 1800, nbf: now - 5 }, parts[1].trim());
}

function pathFor(action) {
  return action === "image_to_video" ? "/v1/videos/image2video" : "/v1/videos/text2video";
}

function urlFor(ctx, action) {
  return ctx.baseUrl + (viaGateway(ctx) ? "/kling" : "") + pathFor(action);
}

function aspectRatio(size) {
  const ratios = { "1024x1024": "1:1", "512x512": "1:1", "1280x720": "16:9", "1920x1080": "16:9", "720x1280": "9:16", "1080x1920": "9:16" };
  return ratios[size] || "1:1";
}

function submitModel(ctx, req) {
  return (ctx && ctx.upstreamModel) || (ctx && ctx.model) || (req && req.model) || "kling-v1";
}

function resolveKlingMode(model, mode) {
  const raw = trimmed(mode).toLowerCase();
  if (model === "kling-v2-master") {
    if (raw === "std") throw new Error("kling-v2-master does not support mode std");
    if (raw && raw !== "pro") throw new Error("mode must be pro");
    return "pro";
  }
  if (!raw) return "std";
  if (raw !== "std" && raw !== "pro") throw new Error("mode must be std or pro");
  return raw;
}

// Kling 3.0 uses the developer-platform contract: the model is part of the
// path, the body nests settings/options, and image-to-video sends `contents`.
const V3_MODEL = "kling-3.0";
const V3_TURBO_MODEL = "kling-3.0-turbo";
const V3_MIN_DURATION = 3;
const V3_MAX_DURATION = 15;
// Turbo shares the contract but drops 4k, native audio, multi_shot and last frames.
const V3_SPECS = {
  [V3_MODEL]: { resolutions: ["720p", "1080p", "4k"], audio: true, multiShot: true, lastFrame: true },
  [V3_TURBO_MODEL]: { resolutions: ["720p", "1080p"], audio: false, multiShot: false, lastFrame: false },
};
// Flat convenience fields folded into settings/options instead of being forwarded.
const V3_FLAT_FIELDS = [
  "model",
  "model_name",
  "mode",
  "image",
  "image_tail",
  "duration",
  "resolution",
  "audio",
  "multi_shot",
  "aspect_ratio",
  "callback_url",
  "external_task_id",
  "watermark_info",
];

function isV3(model) {
  return Object.prototype.hasOwnProperty.call(V3_SPECS, model);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// duration, resolution and audio are billing multipliers, so they are bounded
// here for native bodies and OpenAI-style requests alike.
function v3Settings(req, action, model) {
  const spec = V3_SPECS[model];
  const metadata = plainObject(req.metadata);
  const settings = Object.assign({}, plainObject(metadata.settings));
  const pick = function (key, fallback) {
    if (settings[key] !== undefined && settings[key] !== null) return settings[key];
    if (metadata[key] !== undefined && metadata[key] !== null) return metadata[key];
    return fallback;
  };
  const duration = Number(pick("duration", req.duration === undefined ? 5 : req.duration));
  if (!Number.isInteger(duration) || duration < V3_MIN_DURATION || duration > V3_MAX_DURATION) {
    throw new Error(model + " duration must be an integer between " + V3_MIN_DURATION + " and " + V3_MAX_DURATION);
  }
  settings.duration = duration;
  const resolution = trimmed(pick("resolution", req.resolution || "720p")).toLowerCase();
  if (!spec.resolutions.includes(resolution)) throw new Error(model + " resolution must be one of " + spec.resolutions.join(", "));
  settings.resolution = resolution;
  const audio = trimmed(pick("audio", "off")).toLowerCase();
  if (audio !== "native" && audio !== "off") throw new Error(model + " audio must be native or off");
  if (spec.audio) settings.audio = audio;
  else if (audio !== "off") throw new Error(model + " does not support native audio");
  else delete settings.audio;
  const multiShot = pick("multi_shot", undefined);
  if (multiShot !== undefined) {
    if (typeof multiShot !== "boolean") throw new Error(model + " multi_shot must be a boolean");
    if (!spec.multiShot && multiShot) throw new Error(model + " does not support multi_shot");
    if (spec.multiShot) settings.multi_shot = multiShot;
    else delete settings.multi_shot;
  }
  // Image-to-video inherits the first frame's aspect ratio.
  const ratio = pick("aspect_ratio", req.size ? aspectRatio(req.size) : undefined);
  delete settings.aspect_ratio;
  if (action !== "image_to_video" && ratio !== undefined) settings.aspect_ratio = ratio;
  return settings;
}

function v3Contents(req, metadata, model) {
  const spec = V3_SPECS[model];
  if (Array.isArray(metadata.contents)) {
    const contents = metadata.contents.map(function (item) {
      const entry = Object.assign({}, plainObject(item));
      if (entry.url !== undefined) entry.url = filePlaceholder(entry.url);
      return entry;
    });
    const hasFirstFrame = contents.some(function (item) {
      return item.type === "first_frame";
    });
    if (!hasFirstFrame) throw new Error(model + " image-to-video requires a first_frame content");
    const hasLastFrame = contents.some(function (item) {
      return item.type === "last_frame";
    });
    if (hasLastFrame && !spec.lastFrame) throw new Error(model + " does not support last_frame");
    return contents;
  }
  const first = req.image || metadata.image;
  if (!first) throw new Error(model + " image-to-video requires a first frame image");
  if (metadata.image_tail && !spec.lastFrame) throw new Error(model + " does not support last_frame");
  const contents = [];
  if (trimmed(req.prompt)) contents.push({ type: "prompt", text: req.prompt });
  contents.push({ type: "first_frame", url: filePlaceholder(first) });
  if (metadata.image_tail) contents.push({ type: "last_frame", url: filePlaceholder(metadata.image_tail) });
  return contents;
}

function buildV3Body(req, action, model) {
  const metadata = plainObject(req.metadata);
  const body = {};
  for (const key of Object.keys(metadata)) {
    if (!V3_FLAT_FIELDS.includes(key)) body[key] = metadata[key];
  }
  if (action === "image_to_video") {
    delete body.prompt;
    body.contents = v3Contents(req, metadata, model);
  } else {
    delete body.contents;
    const prompt = trimmed(req.prompt) ? req.prompt : metadata.prompt;
    if (!trimmed(prompt)) throw new Error(model + " text-to-video requires a prompt");
    body.prompt = prompt;
  }
  body.settings = v3Settings(req, action, model);
  const options = Object.assign({}, plainObject(metadata.options));
  for (const key of ["callback_url", "external_task_id", "watermark_info"]) {
    if (options[key] === undefined && metadata[key] !== undefined && metadata[key] !== null) options[key] = metadata[key];
  }
  if (Object.keys(options).length) body.options = options;
  else delete body.options;
  return body;
}

// GET /tasks?task_ids= answers with a task list; the persisted snapshot keeps that shape.
function v3Task(body) {
  const data = body && Array.isArray(body.data) ? body.data : null;
  return data && data.length ? plainObject(data[0]) : null;
}

function v3VideoURL(task) {
  const outputs = task && Array.isArray(task.outputs) ? task.outputs : [];
  for (const output of outputs) {
    if (output && output.type === "video" && trimmed(output.url)) return trimmed(output.url);
  }
  return "";
}

function perSecondRate(model, mode) {
  const table = UNITS_PER_SECOND[model] || UNITS_PER_SECOND["kling-v1"];
  if (table[mode] !== undefined) return table[mode];
  if (table.pro !== undefined) return table.pro;
  return table.std;
}

function estimateUnits(model, mode, durationSeconds) {
  return perSecondRate(model, mode) * durationSeconds;
}

// Official current pages list 3–15s for new models; old-model duration "5"|"10"
// is unverifiable (research 2026-08-27). Keep permissive positive integers up to
// the host task duration bound.
function validateKlingDuration(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 3600) throw new Error("seconds must be a positive integer at most 3600");
  return n;
}

function outboundDuration(req) {
  const n = Number(req && req.duration);
  if (Number.isFinite(n) && n > 0) return n;
  const metadata = (req && req.metadata) || {};
  const fromMeta = Number(metadata.duration);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return 5;
}

function outboundMode(req, model) {
  const metadata = (req && req.metadata) || {};
  return resolveKlingMode(model, (req && req.mode) || metadata.mode);
}

function hasKlingImage(req, hasInputReferenceFile) {
  if (hasInputReferenceFile) return true;
  const metadata = (req && req.metadata) || {};
  if (req && req.image && typeof req.image === "object" && !Array.isArray(req.image) && req.image.__fileRef) return true;
  return Boolean(trimmed(req && req.input_reference) || trimmed(req && req.image) || metadata.image || metadata.image_tail);
}

function filePlaceholder(image) {
  if (!image || typeof image !== "object" || Array.isArray(image) || !image.__fileRef) return image;
  const placeholder = { __fileRef: image.__fileRef, encoding: image.encoding };
  if (image.mimeType) placeholder.mimeType = image.mimeType;
  if (image.maxBytes !== undefined && image.maxBytes !== null) placeholder.maxBytes = image.maxBytes;
  return placeholder;
}

function decodeNativeSubmit(ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const body = ctx.body.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  let model = typeof body.model_name === "string" ? body.model_name : "";
  if (model === "") model = typeof body.model === "string" ? body.model : "";
  if (!model.trim()) throw new Error("model is required");
  return {
    kind: "submit",
    model: model,
    requestBody: {
      model: model,
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      metadata: body,
    },
  };
}

// Native Kling 3.x bodies name the model in the body; the upstream path is
// derived from it at submit time.
function decodeV3For(model, ctx) {
  if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
  const body = ctx.body.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  return {
    kind: "submit",
    model: model,
    requestBody: { model: model, prompt: typeof body.prompt === "string" ? body.prompt : "", metadata: body },
  };
}

function decodeV3BodySubmit(ctx) {
  const body = ctx.body && ctx.body.kind === "json" ? ctx.body.value : null;
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const model = trimmed(source.model || source.model_name);
  if (!model) throw new Error("model is required");
  if (!isV3(model)) throw new Error("model " + model + " is not supported on this route; supported: " + Object.keys(V3_SPECS).join(", "));
  return decodeV3For(model, ctx);
}

// Kling 3.0 identifies tasks by `id` (a single object on create, a list on
// query) instead of the legacy `task_id`.
function isV3Data(data) {
  return Array.isArray(data) || (data && typeof data === "object" && data.id !== undefined && data.task_id === undefined);
}

function v3PublicResult(result, taskID) {
  const tasks = Array.isArray(result.data) ? result.data : [result.data];
  return Object.assign({}, result, {
    data: tasks.map(function (item) {
      return Object.assign({}, plainObject(item), { id: taskID });
    }),
  });
}

export const native = {
  decodeSubmit: decodeNativeSubmit,
  decodeV3BodySubmit: decodeV3BodySubmit,
  taskCreated: function (ctx, task) {
    const result = task.data || {},
      data = result.data || {};
    if (isV3Data(data)) return Object.assign({}, result, { data: Object.assign({}, plainObject(data), { id: task.task_id }) });
    return Object.assign({}, result, { data: Object.assign({}, data, { task_id: task.task_id }) });
  },
  taskStatus: function (ctx, task) {
    if (task.data && typeof task.data === "object" && !Array.isArray(task.data)) {
      const result = task.data;
      if (isV3Data(result.data)) return v3PublicResult(result, task.task_id);
      const data = result.data && typeof result.data === "object" ? result.data : {};
      return Object.assign({}, result, { data: Object.assign({}, data, { task_id: task.task_id }) });
    }
    const statusMap = { NOT_START: "submitted", SUBMITTED: "submitted", QUEUED: "submitted", IN_PROGRESS: "processing", SUCCESS: "succeed", FAILURE: "failed" };
    return { code: 0, data: { task_id: task.task_id, task_status: statusMap[task.status] || "submitted", task_status_msg: task.fail_reason || "" } };
  },
  error: function (ctx, error) {
    return { code: error.code, message: error.message };
  },
};

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody;
  const metadata = req.metadata || {};
  const v3Model = ctx.upstreamModel || ctx.model;
  if (isV3(v3Model)) {
    let v3Action = ctx.action;
    if (v3Action !== "text_to_video" && v3Action !== "image_to_video") {
      v3Action = Array.isArray(metadata.contents) || hasKlingImage(req, false) ? "image_to_video" : "text_to_video";
    }
    const path = v3Action === "image_to_video" ? "/image-to-video" : "/text-to-video";
    // Kling names the model in the path; a New API gateway takes it in the body.
    const gateway = viaGateway(ctx);
    const body = buildV3Body(req, v3Action, v3Model);
    if (gateway) body.model = v3Model;
    return {
      url: ctx.baseUrl + (gateway ? "/kling" + path : path + "/" + v3Model),
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + tokenFor(ctx) },
      body: body,
      action: v3Action,
    };
  }
  const inferredAction = req.image || metadata.image || metadata.image_tail ? "image_to_video" : "text_to_video";
  const action = ctx.action === "text_to_video" || ctx.action === "image_to_video" ? ctx.action : inferredAction;
  const model = ctx.upstreamModel || "kling-v1";
  const body = Object.assign(
    {
      prompt: req.prompt,
      image: req.image,
      mode: outboundMode(req, model),
      duration: String(req.duration || 5),
      aspect_ratio: aspectRatio(req.size),
      model_name: model,
      model: model,
      cfg_scale: 0.5,
    },
    metadata
  );
  body.mode = outboundMode({ mode: body.mode, metadata: metadata }, model);
  if (body.image) body.image = filePlaceholder(body.image);
  if (body.image_tail) body.image_tail = filePlaceholder(body.image_tail);
  if (!body.prompt) delete body.prompt;
  if (!body.image) delete body.image;
  return {
    url: urlFor(ctx, action),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + tokenFor(ctx), "User-Agent": "kling-sdk/1.0" },
    body: body,
    action: action,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const result = resp.body || {};
  if (result.code !== 0) throw new Error(result.message || "kling submit failed");
  const data = result.data || {};
  const taskId = isV3(ctx.upstreamModel || ctx.model) ? data.id : data.task_id;
  if (!taskId) throw new Error("missing task_id");
  return { taskId: taskId, taskData: result };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const req = ctx.requestBody || {};
  const model = submitModel(ctx, req);
  if (isV3(model)) {
    const settings = v3Settings(req, ctx.action, model);
    if (!V3_SPECS[model].audio) return { seconds: settings.duration, resolution: settings.resolution };
    return { seconds: settings.duration, resolution: settings.resolution, native_audio: settings.audio === "native" };
  }
  const duration = outboundDuration(req);
  const mode = outboundMode(req, model);
  return { units: estimateUnits(model, mode, duration) };
}

export function buildQueryRequest(ctx) {
  if (isV3(ctx.upstreamModel || ctx.model)) {
    const id = encodeURIComponent(ctx.taskId);
    return {
      url: ctx.baseUrl + (viaGateway(ctx) ? "/kling/tasks/" + id : "/tasks?task_ids=" + id),
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer " + tokenFor(ctx) },
    };
  }
  return {
    url: urlFor(ctx, ctx.action) + "/" + ctx.taskId,
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer " + tokenFor(ctx), "User-Agent": "kling-sdk/1.0" },
  };
}

export function parseTaskResult(ctx, body) {
  if (Array.isArray(body.data)) {
    const task = v3Task(body);
    if (!task) return { status: "UNKNOWN", reason: body.message || "task not found" };
    const v3Statuses = { submitted: "SUBMITTED", processing: "IN_PROGRESS", succeeded: "SUCCESS", failed: "FAILURE" };
    const v3Status = v3Statuses[task.status];
    if (!v3Status) return { status: "UNKNOWN", reason: "unknown task status: " + String(task.status || "") };
    const v3Result = { code: body.code || 0, taskId: task.id, status: v3Status, reason: v3Status === "FAILURE" ? task.message || "task failed" : "" };
    const url = v3Status === "SUCCESS" ? v3VideoURL(task) : "";
    if (url) v3Result.url = url;
    return v3Result;
  }
  const data = body.data || {};
  const statuses = { submitted: "SUBMITTED", processing: "IN_PROGRESS", succeed: "SUCCESS", failed: "FAILURE" };
  const status = statuses[data.task_status];
  if (!status) return { status: "UNKNOWN", reason: "unknown task status: " + String(data.task_status || "") };
  const videos = status === "SUCCESS" && data.task_result && data.task_result.videos ? data.task_result.videos : [];
  const result = { code: body.code || 0, taskId: data.task_id, status: status, reason: data.task_status_msg || "" };
  if (videos.length && videos[0].url) result.url = videos[0].url;
  const units = Number.parseFloat(data.final_unit_deduction || "");
  if (Number.isFinite(units) && units > 0) {
    result.completionTokens = Math.ceil(units);
    result.totalTokens = Math.ceil(units);
  }
  return result;
}

function artifactData(ctx) {
  const data = (ctx && ctx.data) || {};
  if (data.data && typeof data.data === "object" && data.data.task_id && Object.prototype.hasOwnProperty.call(data.data, "data")) return data.data.data || {};
  return data;
}

function artifactVideoURL(ctx) {
  const snapshot = artifactData(ctx);
  if (Array.isArray(snapshot.data)) return v3VideoURL(v3Task(snapshot));
  const result = (snapshot.data || {}).task_result || {};
  const videos = Array.isArray(result.videos) ? result.videos : [];
  return videos.length ? String(videos[0].url || "").trim() : "";
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && artifactVideoURL(task) ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = artifactVideoURL(ctx);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsageOnComplete(_task, _taskResult, body) {
  const data = (body && body.data) || {};
  if (
    !Object.prototype.hasOwnProperty.call(data, "final_unit_deduction") ||
    data.final_unit_deduction === undefined ||
    data.final_unit_deduction === null ||
    data.final_unit_deduction === ""
  ) {
    return null;
  }
  const units = Number.parseFloat(data.final_unit_deduction);
  if (!Number.isFinite(units)) return null;
  return { units: units };
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(ctx.model);
      if (!model) throw new Error("model is required");
      if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) throw new Error("input must be a string or array");
      if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
      if (req.metadata !== undefined && (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)))
        throw new Error("metadata must be an object");
      const input = responsesInput(req);
      const prompt = input.prompt || trimmed(req.prompt);
      const images = [];
      for (const image of [req.image, req.input_reference].concat(req.images || [], input.images)) {
        if (trimmed(image) && !images.includes(trimmed(image))) images.push(trimmed(image));
      }
      if (!prompt && images.length === 0) throw new Error("input is required");
      const metadata = Object.assign({}, req.metadata || {});
      if (Object.prototype.hasOwnProperty.call(req, "mode")) metadata.mode = req.mode;
      metadata.mode = resolveKlingMode(ctx.upstreamModel || model, metadata.mode);
      if (images.length > 1 && !metadata.image_tail) metadata.image_tail = images[1];
      const requestBody = { model: model, prompt: prompt, metadata: metadata };
      if (images.length) requestBody.image = images[0];
      if (Object.prototype.hasOwnProperty.call(req, "seconds")) requestBody.duration = req.seconds;
      else if (Object.prototype.hasOwnProperty.call(req, "duration")) requestBody.duration = req.duration;
      if (Object.prototype.hasOwnProperty.call(req, "size")) requestBody.size = req.size;
      return { kind: "submit", model: model, action: images.length ? "image_to_video" : "text_to_video", requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responsesVideoText(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE")
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx, _task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesVideoText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "kling" },
      };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
      let req;
      let hasInputReferenceFile = false;
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
        req = Object.assign({}, ctx.body.value);
      } else {
        const first = function (name) {
          const values = (ctx.body.fields || {})[name] || [];
          if (values.length > 1) throw new Error(name + " must be provided once");
          return values[0];
        };
        req = {};
        const fields = ctx.body.fields || {};
        for (const name of Object.keys(fields)) {
          req[name] = first(name);
        }
        for (const file of ctx.body.files || []) {
          if (file.field !== "input_reference") throw new Error("unexpected file field: " + file.field);
          if (hasInputReferenceFile) throw new Error("input_reference must be provided once");
          hasInputReferenceFile = true;
        }
        if (req.metadata !== undefined) {
          let parsed;
          try {
            parsed = JSON.parse(req.metadata);
          } catch (e) {
            throw new Error("metadata must be a JSON object string");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be a JSON object string");
          req.metadata = parsed;
        }
        if (req.seconds !== undefined) req.seconds = Number(req.seconds);
        else if (req.duration !== undefined) req.seconds = Number(req.duration);
      }
      const seconds = req.seconds === undefined ? req.duration : req.seconds;
      if (seconds !== undefined) req.duration = validateKlingDuration(seconds);
      else req.duration = 5;
      if (hasInputReferenceFile) {
        req.image = { __fileRef: "request_file:input_reference", encoding: "base64", maxBytes: 10485760 };
      } else {
        const image = trimmed(req.input_reference || req.image);
        if (image) req.image = image;
      }
      const model = ctx.upstreamModel || ctx.model || req.model || "kling-v1";
      const metadata = req.metadata || {};
      req.mode = resolveKlingMode(model, req.mode || metadata.mode);
      const hasImage = hasKlingImage(req, hasInputReferenceFile);
      return {
        kind: "submit",
        model: ctx.model,
        action: hasImage ? "image_to_video" : "text_to_video",
        requestBody: Object.assign({}, req, { model: ctx.model }),
      };
    },
    render: function (ctx, task) {
      const response = task.data || {};
      const data = response.data || {};
      const statusMap = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = {
        id: task.task_id,
        object: "video",
        model: "",
        status: statusMap[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: data.created_at || 0,
      };
      if (data.updated_at) output.completed_at = data.updated_at;
      const videos = data.task_result && data.task_result.videos ? data.task_result.videos : [];
      if (videos.length) {
        if (videos[0].duration) output.seconds = videos[0].duration;
      }
      if (response.code !== 0 && response.message) output.error = { message: response.message, code: String(response.code) };
      if (data.task_status === "failed") output.error = { message: data.task_status_msg, code: "" };
      return output;
    },
  },
};
