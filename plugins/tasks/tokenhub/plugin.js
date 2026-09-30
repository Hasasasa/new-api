// Tencent TokenHub 3D generation. Hunyuan 3D (hy-3d-*) and Tripo (tripo-3d-*)
// share the async pair POST /v1/api/3d/submit and POST /v1/api/3d/query with a
// Bearer API key, and both answer with an object of type "3d_job".
const HY_MODELS = ["hy-3d-3.0", "hy-3d-3.1"];
const TRIPO_MODELS = ["tripo-3d-3.1", "tripo-3d-p1"];

const GENERATION_FIELD = {
  type: "number",
  unit: "count",
  unitLabel: { en: "model", zh: "个", "zh-TW": "個" },
  description: { en: "3D model generation unit price", zh: "3D 模型生成单价" },
};

// Hunyuan 3D bills by generate_type plus the optional add-ons.
const HY_USAGE_SCHEMA = {
  // Always 1: one accepted task produces one model, however many file formats
  // the vendor returns.
  generations: GENERATION_FIELD,
  generate_type: {
    enum: ["normal", "lowpoly", "geometry", "sketch"],
    enumLabels: {
      normal: { en: "Textured model", zh: "带纹理模型" },
      lowpoly: { en: "Low-poly topology", zh: "智能拓扑" },
      geometry: { en: "Geometry only", zh: "白模" },
      sketch: { en: "Sketch input", zh: "草图生成" },
    },
    description: { en: "Generation type", zh: "生成类型" },
  },
  pbr: { type: "boolean", description: { en: "Whether PBR materials are generated", zh: "是否生成 PBR 材质" } },
  multi_view: { type: "boolean", description: { en: "Multi-view images present", zh: "存在多视角图片" } },
  // face_count / result_format are only billable when the client actually asks
  // for them, and the vendor ignores face_count in low_poly mode.
  custom_face_count: { type: "boolean", description: { en: "Whether a face count is requested", zh: "是否指定面数" } },
  custom_result_format: { type: "boolean", description: { en: "Whether an output format is requested", zh: "是否指定输出格式" } },
};

// Tripo bills by the requested pipeline; the vendor publishes only a
// 15-60 credit range per call, so the billable dimensions are exposed as facts
// and the operator prices them.
const TRIPO_USAGE_SCHEMA = {
  generations: GENERATION_FIELD,
  input: {
    enum: ["text", "image", "multiview"],
    enumLabels: {
      text: { en: "Text to 3D", zh: "文生 3D" },
      image: { en: "Image to 3D", zh: "图生 3D" },
      multiview: { en: "Multi-view to 3D", zh: "多视图生 3D" },
    },
    description: { en: "Input type", zh: "输入类型" },
  },
  texture: { type: "boolean", description: { en: "Whether textures are generated", zh: "是否生成贴图" } },
  pbr: { type: "boolean", description: { en: "Whether PBR materials are generated", zh: "是否生成 PBR 材质" } },
  texture_quality: {
    enum: ["standard", "detailed", "extreme"],
    enumLabels: {
      standard: { en: "Standard", zh: "标准" },
      detailed: { en: "Detailed", zh: "精细" },
      extreme: { en: "Extreme 8K", zh: "极致 8K" },
    },
    description: { en: "Texture quality", zh: "贴图质量" },
  },
  geometry_quality: {
    enum: ["standard", "detailed"],
    enumLabels: { standard: { en: "Standard", zh: "标准" }, detailed: { en: "Detailed", zh: "精细" } },
    description: { en: "Geometry quality", zh: "几何质量" },
  },
  quad: { type: "boolean", description: { en: "Whether quad mesh is generated", zh: "是否生成四边面" } },
  smart_low_poly: { type: "boolean", description: { en: "Whether smart low-poly is generated", zh: "是否生成智能低模" } },
  generate_parts: { type: "boolean", description: { en: "Whether editable parts are generated", zh: "是否生成可编辑部件" } },
};

function tripoFacts(input, body) {
  return {
    generations: 1,
    input: input,
    texture: body.texture !== false,
    pbr: body.pbr !== false,
    texture_quality: trimmed(body.texture_quality).toLowerCase() || "standard",
    geometry_quality: trimmed(body.geometry_quality).toLowerCase() || "standard",
    quad: body.quad === true,
    smart_low_poly: body.smart_low_poly === true,
    generate_parts: body.generate_parts === true,
  };
}

export const meta = {
  apiVersion: 1,
  key: "tokenhub",
  name: "TokenHub 3D",
  icon: "text:3D",
  description: {
    en: "Tencent TokenHub 3D generation (Hunyuan 3D and Tripo)",
    zh: "腾讯 TokenHub 3D 生成（混元生 3D、Tripo 生 3D）",
  },
  version: "1.0.0",
  author: { name: "QuantumNous" },
  baseUrl: "https://tokenhub.tencentmaas.com",
  upstreams: ["vendor", "new_api"],
  models: HY_MODELS.concat(TRIPO_MODELS),
  fetchMode: "per_task",
  usageSchema: HY_USAGE_SCHEMA,
  usageExamples: [
    { label: "Normal", facts: { generations: 1, generate_type: "normal", pbr: false, multi_view: false, custom_face_count: false, custom_result_format: false } },
    { label: "Normal · pbr", facts: { generations: 1, generate_type: "normal", pbr: true, multi_view: false, custom_face_count: false, custom_result_format: false } },
    { label: "LowPoly · face count", facts: { generations: 1, generate_type: "lowpoly", pbr: false, multi_view: false, custom_face_count: true, custom_result_format: false } },
    { label: "Geometry", facts: { generations: 1, generate_type: "geometry", pbr: false, multi_view: false, custom_face_count: false, custom_result_format: false } },
  ],
  usageProfiles: [
    {
      models: TRIPO_MODELS,
      schema: TRIPO_USAGE_SCHEMA,
      examples: [
        { label: "Text to 3D", facts: tripoFacts("text", {}) },
        { label: "Image to 3D", facts: tripoFacts("image", {}) },
        { label: "Image to 3D · geometry only", facts: tripoFacts("image", { texture: false, pbr: false, texture_quality: "standard", geometry_quality: "standard" }) },
      ],
    },
  ],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }],
  routes: [
    { method: "POST", path: "/tokenhub/v1/api/3d/submit", type: "submit", decode: "decodeSubmit", render: "renderSubmit" },
    // Querying by a vendor task id would expose every tenant's tasks, so this
    // route resolves the platform task id and renders the stored snapshot. A
    // dynamic route keeps batch queries available.
    { method: "POST", path: "/tokenhub/v1/api/3d/query", type: "dynamic", decode: "decodeQuery", render: "renderQuery" },
  ],
};

// Vendor view vocabularies for multi-view input. The first frame is mapped to
// the leading entry, so the extras continue from index 1.
const HUNYUAN_VIEWS = ["left", "right", "back", "top", "bottom", "left_front", "right_front"];
const TRIPO_VIEWS = ["front", "back", "left", "right"];

function trimmed(value) {
  return String(value || "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// TokenHub issues its own keys with an sk- prefix, so the key can never tell a
// gateway from the vendor; only the host signal can. On a New API channel the
// same plugin answers its own prefixed routes.
function viaGateway(ctx) {
  return !!(ctx.upstream && ctx.upstream.kind === "new_api");
}

function endpoint(ctx, path) {
  return ctx.baseUrl + (viaGateway(ctx) ? "/tokenhub" : "") + path;
}

function isTripo(model) {
  return TRIPO_MODELS.indexOf(model) >= 0;
}

function isKnownModel(model) {
  return HY_MODELS.indexOf(model) >= 0 || TRIPO_MODELS.indexOf(model) >= 0;
}

function boundedInteger(value, name, minimum, maximum) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < minimum || n > maximum) {
    throw new Error(name + " must be an integer between " + minimum + " and " + maximum);
  }
  return n;
}

function pickEnum(value, name, allowed, fallback) {
  const raw = trimmed(value).toLowerCase();
  if (!raw) return fallback;
  if (allowed.indexOf(raw) < 0) throw new Error(name + " must be one of " + allowed.join(", "));
  return raw;
}

function requireOneInput(body, keys, sketchAllowsBoth, model) {
  const present = keys.filter(function (key) {
    return trimmed(body[key]) !== "";
  });
  if (present.length === 0) throw new Error(model + " requires one of " + keys.join(", "));
  if (present.length > 1 && !sketchAllowsBoth) throw new Error(model + " accepts only one of " + keys.join(", "));
}

function outboundModel(ctx) {
  const model = trimmed(ctx.upstreamModel || ctx.model);
  if (!isKnownModel(model)) throw new Error("model " + model + " is not supported; supported: " + HY_MODELS.concat(TRIPO_MODELS).join(", "));
  return model;
}

const HUNYUAN_GENERATE_TYPES = { normal: "Normal", lowpoly: "LowPoly", geometry: "Geometry", sketch: "Sketch" };

// The vendor bills the generation type and each add-on it accepts, so the
// request is normalized to one canonical spelling before it is sent.
function normalizeHunyuanBody(metadata, model) {
  const body = Object.assign({}, metadata);
  delete body.model;
  delete body.model_name;
  body.model = model;
  const generateType = pickEnum(body.generate_type, "generate_type", ["normal", "lowpoly", "geometry", "sketch"], "normal");
  if ((generateType === "lowpoly" || generateType === "sketch") && model === "hy-3d-3.1") {
    throw new Error("hy-3d-3.1 does not support generate_type " + generateType);
  }
  // The vendor enum is case-sensitive; billing facts lowercase it again.
  body.generate_type = HUNYUAN_GENERATE_TYPES[generateType];
  requireOneInput(body, ["prompt", "image_base64", "image_url"], generateType === "sketch", model);
  if (body.polygon_type !== undefined) {
    if (generateType !== "lowpoly") throw new Error("polygon_type requires generate_type lowpoly");
    body.polygon_type = pickEnum(body.polygon_type, "polygon_type", ["triangle", "quadrilateral"], "triangle");
  }
  // Both are documented as having no effect here, so neither is sent nor billed.
  if (generateType === "geometry" || body.enable_pbr === undefined) delete body.enable_pbr;
  if (generateType === "lowpoly") delete body.face_count;
  if (body.face_count !== undefined) body.face_count = boundedInteger(body.face_count, "face_count", 3000, 1500000);
  if (body.result_format !== undefined) body.result_format = pickEnum(body.result_format, "result_format", ["stl", "usdz", "fbx"]);
  if (body.multi_view_images !== undefined && !Array.isArray(body.multi_view_images)) throw new Error("multi_view_images must be an array");
  return body;
}

function normalizeTripoBody(metadata, model) {
  const body = Object.assign({}, metadata);
  delete body.model;
  delete body.model_name;
  body.model = model;
  requireOneInput(body, ["prompt", "input", "inputs"], false, model);
  if (body.face_limit !== undefined) {
    const maximum = model === "tripo-3d-p1" ? 20000 : 2000000;
    body.face_limit = boundedInteger(body.face_limit, "face_limit", 50, maximum);
  }
  if (body.texture_quality !== undefined) body.texture_quality = pickEnum(body.texture_quality, "texture_quality", ["standard", "detailed", "extreme"], "standard");
  if (model === "tripo-3d-p1") {
    ["geometry_quality", "quad", "smart_low_poly", "generate_parts"].forEach(function (key) {
      if (body[key] !== undefined) throw new Error(model + " does not support " + key);
    });
  }
  if (body.geometry_quality !== undefined) body.geometry_quality = pickEnum(body.geometry_quality, "geometry_quality", ["standard", "detailed"], "standard");
  if (body.texture_alignment !== undefined) body.texture_alignment = pickEnum(body.texture_alignment, "texture_alignment", ["original_image", "geometry"], "original_image");
  if (body.orientation !== undefined) body.orientation = pickEnum(body.orientation, "orientation", ["default", "align_image"], "default");
  // pbr forces texture upstream; generating parts rejects both plus quad.
  if (body.pbr === true) body.texture = true;
  if (body.generate_parts === true && (body.texture !== false || body.pbr !== false || body.quad === true)) {
    throw new Error(model + " generate_parts requires texture, pbr and quad all false");
  }
  return body;
}

function tripoInputType(body) {
  if (Array.isArray(body.inputs) ? body.inputs.length > 0 : trimmed(body.inputs) !== "") return "multiview";
  if (trimmed(body.input) !== "") return "image";
  return "text";
}

function hunyuanFacts(body) {
  return {
    generations: 1,
    generate_type: trimmed(body.generate_type).toLowerCase() || "normal",
    pbr: body.enable_pbr === true,
    multi_view: Array.isArray(body.multi_view_images) && body.multi_view_images.length > 0,
    custom_face_count: body.face_count !== undefined,
    custom_result_format: body.result_format !== undefined,
  };
}

function actionFor(model, body) {
  if (isTripo(model)) return tripoInputType(body) === "text" ? "text_to_3d" : "image_to_3d";
  return trimmed(body.image_url) || trimmed(body.image_base64) ? "image_to_3d" : "text_to_3d";
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const metadata = plainObject(req.metadata);
  const model = outboundModel(ctx);
  const body = isTripo(model) ? normalizeTripoBody(metadata, model) : normalizeHunyuanBody(metadata, model);
  return {
    url: endpoint(ctx, "/v1/api/3d/submit"),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: body,
    action: actionFor(model, body),
  };
}

// TokenHub wraps failures as {"error":{message, message_zh, code}}.
function apiErrorMessage(body) {
  const error = plainObject(body.error);
  return trimmed(error.message_zh) || trimmed(error.message) || trimmed(body.message);
}

export function parseSubmitResponse(ctx, resp) {
  const body = plainObject(resp.body);
  if (!body.id) throw new Error(apiErrorMessage(body) || "missing task id");
  return { taskId: String(body.id), taskData: body };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const req = ctx.requestBody || {};
  const metadata = plainObject(req.metadata);
  const model = outboundModel(ctx);
  if (isTripo(model)) {
    const body = normalizeTripoBody(metadata, model);
    return tripoFacts(tripoInputType(body), body);
  }
  return hunyuanFacts(normalizeHunyuanBody(metadata, model));
}

export function buildQueryRequest(ctx) {
  return {
    url: endpoint(ctx, "/v1/api/3d/query"),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: { model: trimmed(ctx.upstreamModel || ctx.model), id: ctx.taskId },
  };
}

// Hunyuan answers with data[] (one entry per file); Tripo answers with output.
function resultURLs(data) {
  const urls = [];
  if (Array.isArray(data.data)) {
    for (const entry of data.data) {
      const url = trimmed(entry && entry.url);
      if (url) urls.push({ key: trimmed(entry.type) || "model", type: "file", url: url });
    }
    return urls;
  }
  const output = plainObject(data.output);
  if (trimmed(output.model_url)) urls.push({ key: "model", type: "file", url: trimmed(output.model_url) });
  if (trimmed(output.rendered_image_url)) urls.push({ key: "preview", type: "image", url: trimmed(output.rendered_image_url) });
  return urls;
}

export function parseTaskResult(ctx, body) {
  // The shared enum documents completed; the Tripo guide's own example answers
  // success, so both spellings are accepted for a finished task.
  const statuses = { queued: "QUEUED", in_progress: "IN_PROGRESS", processing: "IN_PROGRESS", running: "IN_PROGRESS", completed: "SUCCESS", success: "SUCCESS", failed: "FAILURE" };
  const status = statuses[trimmed(body && body.status).toLowerCase()];
  if (!status) return { status: "UNKNOWN", reason: "unknown task status: " + String((body && body.status) || "") };
  const result = { code: body.code || 0, taskId: body.id, status: status, reason: status === "FAILURE" ? trimmed(body.message) || "task failed" : "" };
  const urls = status === "SUCCESS" ? resultURLs(plainObject(body)) : [];
  if (urls.length) result.url = urls[0].url;
  return result;
}

function artifactData(ctx) {
  const data = (ctx && ctx.data) || {};
  if (data.data && typeof data.data === "object" && data.data.id && Object.prototype.hasOwnProperty.call(data.data, "data")) return data.data.data || {};
  return data;
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  const seen = {};
  return resultURLs(artifactData(task)).map(function (item) {
    const key = seen[item.key] ? item.key + "-" + seen[item.key] : item.key;
    seen[item.key] = (seen[item.key] || 0) + 1;
    return { key: key, type: item.type };
  });
}

export function buildContentRequest(ctx) {
  const urls = resultURLs(artifactData(ctx));
  for (const item of urls) {
    if (item.key === ctx.artifactKey) return { url: item.url, method: ctx.clientRequest.method, credentialless: true };
  }
  throw new Error("artifact_not_found");
}

export function extractUsageOnComplete() {
  return null;
}

export const native = {
  decodeSubmit: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
    const model = trimmed(body.model || body.model_name);
    if (!model) throw new Error("model is required");
    return { kind: "submit", model: model, requestBody: { model: model, metadata: body } };
  },
  decodeQuery: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value || {};
    const raw = body.task_id === undefined ? body.id : body.task_id;
    const ids = (Array.isArray(raw) ? raw : [raw])
      .map(function (value) {
        return trimmed(value);
      })
      .filter(function (value) {
        return value !== "";
      });
    if (!ids.length) throw new Error("task_id is required");
    // The host resolves at most 100 task ids per query.
    if (ids.length > 100) throw new Error("task_id accepts at most 100 ids");
    return { kind: "query", taskIds: ids };
  },
  renderSubmit: function (ctx, task) {
    const stored = plainObject(task.data);
    return Object.assign({}, stored, { id: task.task_id });
  },
  // A dynamic route always passes an array; a single task keeps the vendor's
  // single-object envelope, several tasks answer as a list.
  renderQuery: function (ctx, tasks) {
    const views = Array.isArray(tasks) ? tasks : [tasks];
    const rendered = views.map(function (task) {
      return Object.assign({}, plainObject(task && task.data), { id: task.task_id });
    });
    return rendered.length === 1 ? rendered[0] : { data: rendered };
  },
  error: function (ctx, error) {
    return { code: error.httpStatus, message: error.message };
  },
};

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

// A 3D deliverable is a file, so the Responses output lists its links.
function responsesModelText(ctx) {
  const artifacts = plainObject(ctx && ctx.artifacts);
  const urls = Object.keys(artifacts)
    .sort()
    .map(function (key) {
      return trimmed(artifacts[key] && artifacts[key].url);
    })
    .filter(function (url) {
      return url !== "";
    });
  if (!urls.length) throw new Error("3D artifact is unavailable");
  return urls.join("\n");
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const req = ctx.body.value;
    if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
    const model = trimmed(ctx.model);
    if (!model) throw new Error("model is required");
    const input = responsesInput(req);
    const prompt = input.prompt || trimmed(req.prompt);
    const metadata = Object.assign({}, plainObject(req.metadata));
    if (prompt) metadata.prompt = prompt;
    if (input.images.length) {
      if (isTripo(ctx.upstreamModel || model)) metadata.input = input.images[0];
      else metadata.image_url = input.images[0];
    }
    if (input.images.length > 1) {
      const extra = input.images.slice(1);
      if (isTripo(ctx.upstreamModel || model)) {
        // inputs is a view map, so each extra image takes the next declared
        // view instead of every image claiming the same one.
        metadata.inputs = extra.map(function (url, index) {
          const view = {};
          view[TRIPO_VIEWS[Math.min(index + 1, TRIPO_VIEWS.length - 1)]] = url;
          return view;
        });
      } else {
        metadata.multi_view_images = extra.map(function (url, index) {
          return { view_type: HUNYUAN_VIEWS[Math.min(index + 1, HUNYUAN_VIEWS.length - 1)], view_image_url: url };
        });
      }
    }
    return { kind: "submit", model: model, requestBody: { model: model, metadata: metadata } };
  },
  renderEvents: function (ctx, task, previousState) {
    const status = String(task.status || "UNKNOWN").toUpperCase();
    const value = Number(String(task.progress || "").replace("%", ""));
    const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    const state = { status: status, progress: progress };
    if (status === "SUCCESS") {
      const text = responsesModelText(ctx);
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
            content: [{ type: "output_text", text: responsesModelText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "tokenhub" },
      };
    },
  },
};
