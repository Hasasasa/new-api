// World Labs Marble world generation. POST /marble/v1/worlds:generate starts a
// long-running operation polled at GET /marble/v1/operations/{operation_id};
// both authenticate with the WLT-Api-Key header.
const MODELS = ["marble-1.0-draft", "marble-1.0", "marble-1.1", "marble-1.1-plus"];

// Vendor credit table: a world generation event plus a pano generation event
// when the input is not already a panorama. marble-1.1-plus adds up to 1500
// variable credits decided during inference.
const WORLD_CREDITS = { "marble-1.0-draft": 150, "marble-1.0": 1500, "marble-1.1": 1500, "marble-1.1-plus": 1500 };
const PLUS_VARIABLE_CREDITS = 1500;
const PANO_CREDITS = { text: 80, image: 80, "multi-image": 100 };

function trimmed(value) {
  return String(value || "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function usageFacts(credits) {
  return { credits: credits };
}

export const meta = {
  apiVersion: 1,
  key: "worldlabs",
  name: "World Labs",
  icon: "text:WL",
  description: {
    en: "World Labs Marble 3D world generation",
    zh: "World Labs Marble 3D 世界生成",
  },
  version: "1.0.0",
  author: { name: "QuantumNous" },
  baseUrl: "https://api.worldlabs.ai",
  upstreams: ["vendor", "new_api"],
  models: MODELS,
  fetchMode: "per_task",
  usageSchema: {
    // Reserved from the vendor credit table at submit (the variable
    // marble-1.1-plus charge at its maximum) and settled to the operation's
    // cost.total_credits on completion.
    credits: {
      type: "number",
      unit: "credit",
      description: { en: "World generation credit unit price", zh: "世界生成积分单价" },
    },
  },
  usageExamples: [
    { label: "1.0-draft · text", facts: usageFacts(230) },
    { label: "1.1 · pano", facts: usageFacts(1500) },
    { label: "1.1 · text", facts: usageFacts(1580) },
    { label: "1.1-plus · multi-image max", facts: usageFacts(3100) },
  ],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }],
  routes: [
    { method: "POST", path: "/worldlabs/marble/v1/worlds/generate", type: "submit", decode: "decodeSubmit", render: "renderOperation" },
    // The path carries the platform task id: the host resolves it for the
    // caller only, so vendor operation ids never become a lookup key.
    { method: "GET", path: "/worldlabs/marble/v1/operations/:task_id", type: "query", render: "renderOperation" },
  ],
};

function viaGateway(ctx) {
  return !!(ctx.upstream && ctx.upstream.kind === "new_api");
}

function endpoint(ctx, path) {
  return ctx.baseUrl + (viaGateway(ctx) ? "/worldlabs" : "") + path;
}

// Host route segments cannot contain ":", so the gateway serves the vendor's
// worlds:generate action at worlds/generate.
function generateEndpoint(ctx) {
  return viaGateway(ctx) ? endpoint(ctx, "/marble/v1/worlds/generate") : endpoint(ctx, "/marble/v1/worlds:generate");
}

// A gateway authenticates its native routes with a Bearer token; the vendor
// reads its own header.
function authHeaders(ctx) {
  if (viaGateway(ctx)) return { Authorization: ctx.authHeader || "Bearer " + ctx.apiKey };
  return { "WLT-Api-Key": trimmed(ctx.apiKey) };
}

function outboundModel(ctx) {
  const model = trimmed(ctx.upstreamModel || ctx.model);
  if (MODELS.indexOf(model) < 0) throw new Error("model " + model + " is not supported; supported: " + MODELS.join(", "));
  return model;
}

// Media assets are uploaded to the operator's vendor account, which clients
// cannot reach, so only inline data and public URLs are accepted.
function mediaReference(value, name) {
  const ref = plainObject(value);
  const source = trimmed(ref.source);
  if (source === "uri") {
    if (!trimmed(ref.uri)) throw new Error(name + ".uri is required");
    return { source: "uri", uri: trimmed(ref.uri) };
  }
  if (source === "data_base64") {
    if (!trimmed(ref.data_base64)) throw new Error(name + ".data_base64 is required");
    const out = { source: "data_base64", data_base64: ref.data_base64 };
    if (trimmed(ref.extension)) out.extension = trimmed(ref.extension);
    return out;
  }
  throw new Error(name + ".source must be uri or data_base64");
}

function normalizeWorldPrompt(value) {
  const prompt = plainObject(value);
  const type = trimmed(prompt.type);
  const out = { type: type };
  if (trimmed(prompt.text_prompt)) out.text_prompt = trimmed(prompt.text_prompt);
  if (prompt.disable_recaption !== undefined) {
    if (typeof prompt.disable_recaption !== "boolean") throw new Error("disable_recaption must be a boolean");
    out.disable_recaption = prompt.disable_recaption;
  }
  if (type === "text") {
    if (!out.text_prompt) throw new Error("world_prompt.text_prompt is required for text input");
    return out;
  }
  if (type === "image") {
    out.image_prompt = mediaReference(prompt.image_prompt, "world_prompt.image_prompt");
    if (prompt.is_pano !== undefined) {
      if (prompt.is_pano !== true && prompt.is_pano !== false && prompt.is_pano !== "auto") throw new Error("world_prompt.is_pano must be true, false or auto");
      out.is_pano = prompt.is_pano;
    }
    return out;
  }
  if (type === "multi-image") {
    const reconstruct = prompt.reconstruct_images === true;
    const images = prompt.multi_image_prompt;
    const maximum = reconstruct ? 8 : 4;
    if (!Array.isArray(images) || images.length === 0 || images.length > maximum) {
      throw new Error("world_prompt.multi_image_prompt must contain 1 to " + maximum + " images");
    }
    out.multi_image_prompt = images.map(function (item, index) {
      const entry = plainObject(item);
      const located = { content: mediaReference(entry.content, "world_prompt.multi_image_prompt[" + index + "].content") };
      if (entry.azimuth !== undefined && entry.azimuth !== null) {
        const azimuth = Number(entry.azimuth);
        if (!Number.isFinite(azimuth)) throw new Error("world_prompt.multi_image_prompt[" + index + "].azimuth must be a number");
        located.azimuth = azimuth;
      }
      return located;
    });
    if (reconstruct) out.reconstruct_images = true;
    return out;
  }
  if (type === "video") throw new Error("video input is not supported");
  throw new Error("world_prompt.type must be one of text, image, multi-image");
}

// Only generation fields are forwarded. permission is dropped because the
// world belongs to the operator's vendor account: a client must not publish it
// or grant other accounts access to it.
function normalizeBody(req, model) {
  const source = plainObject(req);
  const body = { model: model, world_prompt: normalizeWorldPrompt(source.world_prompt) };
  if (trimmed(source.display_name)) body.display_name = trimmed(source.display_name);
  if (Array.isArray(source.tags)) body.tags = source.tags;
  if (source.seed !== undefined && source.seed !== null) {
    const seed = Number(source.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("seed must be an integer between 0 and 4294967295");
    body.seed = seed;
  }
  return body;
}

function estimatedCredits(body) {
  const prompt = body.world_prompt;
  const pano = prompt.type === "image" && prompt.is_pano === true ? 0 : PANO_CREDITS[prompt.type];
  const variable = body.model === "marble-1.1-plus" ? PLUS_VARIABLE_CREDITS : 0;
  return WORLD_CREDITS[body.model] + variable + pano;
}

export function buildSubmitRequest(ctx) {
  const body = normalizeBody(ctx.requestBody, outboundModel(ctx));
  return {
    url: generateEndpoint(ctx),
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json" }, authHeaders(ctx)),
    body: body,
    action: body.world_prompt.type === "text" ? "text_to_3d" : "image_to_3d",
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = plainObject(resp.body);
  if (!trimmed(body.operation_id)) throw new Error(trimmed(body.detail) || "missing operation_id");
  return { taskId: trimmed(body.operation_id), taskData: body };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  return usageFacts(estimatedCredits(normalizeBody(ctx.requestBody, outboundModel(ctx))));
}

export function buildQueryRequest(ctx) {
  return {
    url: endpoint(ctx, "/marble/v1/operations/" + encodeURIComponent(ctx.taskId)),
    method: "GET",
    headers: Object.assign({ Accept: "application/json" }, authHeaders(ctx)),
  };
}

function worldAssets(data) {
  const assets = plainObject(plainObject(plainObject(data).response).assets);
  const items = [];
  const add = function (key, type, url) {
    if (trimmed(url)) items.push({ key: key, type: type, url: trimmed(url) });
  };
  const spz = plainObject(plainObject(assets.splats).spz_urls);
  Object.keys(spz)
    .sort()
    .forEach(function (name) {
      add("spz-" + name.replace(/[^A-Za-z0-9._~-]/g, "_"), "file", spz[name]);
    });
  const mesh = plainObject(assets.mesh);
  add("mesh-hq", "file", mesh.hq_mesh_url);
  add("mesh-full-res", "file", mesh.full_res_mesh_url);
  add("mesh-collider", "file", mesh.collider_mesh_url);
  add("pano", "image", plainObject(assets.imagery).pano_url);
  add("thumbnail", "image", assets.thumbnail_url);
  return items;
}

export function parseTaskResult(ctx, body) {
  const data = plainObject(body);
  if (typeof data.done !== "boolean") return { status: "UNKNOWN", reason: "operation response has no done flag" };
  const result = { code: 0, taskId: trimmed(data.operation_id) || ctx.taskId, status: "IN_PROGRESS", reason: "" };
  if (!data.done) {
    const progress = trimmed(plainObject(plainObject(data.metadata).progress).status).toUpperCase();
    if (progress === "PENDING" || progress === "QUEUED" || progress === "NOT_STARTED") result.status = "QUEUED";
    return result;
  }
  const error = plainObject(data.error);
  if (data.error) {
    result.status = "FAILURE";
    result.reason = trimmed(error.message) || "world generation failed";
    return result;
  }
  const assets = worldAssets(data);
  if (!data.response) {
    result.status = "FAILURE";
    result.reason = "operation finished without a world";
    return result;
  }
  result.status = "SUCCESS";
  if (assets.length) result.url = assets[0].url;
  return result;
}

// The operation carries its settled cost only on success; until then the
// reservation stands.
export function extractUsageOnComplete(task, result, body) {
  if (!result || result.status !== "SUCCESS") return null;
  const credits = plainObject(plainObject(body).cost).total_credits;
  if (typeof credits !== "number" || !Number.isFinite(credits)) return null;
  return usageFacts(credits);
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return worldAssets(task.data).map(function (item) {
    return { key: item.key, type: item.type };
  });
}

export function buildContentRequest(ctx) {
  for (const item of worldAssets(ctx.data)) {
    if (item.key === ctx.artifactKey) return { url: item.url, method: ctx.clientRequest.method, credentialless: true };
  }
  throw new Error("artifact_not_found");
}

export const native = {
  decodeSubmit: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
    const model = trimmed(body.model);
    if (!model) throw new Error("model is required");
    const prompt = plainObject(body.world_prompt);
    const action = trimmed(prompt.type) === "text" ? "text_to_3d" : "image_to_3d";
    return { kind: "submit", model: model, action: action, requestBody: body };
  },
  // The host replaces id/task_id fields only; operation_id is the vendor's own
  // name for the task id, so it is set to the public id here.
  renderOperation: function (ctx, task) {
    return Object.assign({}, plainObject(task.data), { operation_id: task.task_id });
  },
  error: function (ctx, error) {
    return { detail: error.message };
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
  return { prompt: texts.filter(trimmed).join("\n"), images: images };
}

// One image becomes an image prompt; several become views spread evenly
// around the sphere.
function responsesWorldPrompt(input) {
  const prompt = {};
  if (input.prompt) prompt.text_prompt = input.prompt;
  if (input.images.length === 0) return Object.assign({ type: "text" }, prompt);
  if (input.images.length === 1) return Object.assign({ type: "image", image_prompt: { source: "uri", uri: input.images[0] } }, prompt);
  if (input.images.length > 4) throw new Error("at most 4 images are supported");
  const step = 360 / input.images.length;
  return Object.assign(
    {
      type: "multi-image",
      multi_image_prompt: input.images.map(function (uri, index) {
        return { azimuth: index * step, content: { source: "uri", uri: uri } };
      }),
    },
    prompt,
  );
}

function responsesWorldText(ctx) {
  const artifacts = plainObject(ctx && ctx.artifacts);
  const urls = Object.keys(artifacts)
    .sort()
    .map(function (key) {
      return trimmed(artifacts[key] && artifacts[key].url);
    })
    .filter(function (url) {
      return url !== "";
    });
  if (!urls.length) throw new Error("world artifact is unavailable");
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
      const worldPrompt = responsesWorldPrompt(responsesInput(req));
      if (worldPrompt.type === "text" && !worldPrompt.text_prompt) throw new Error("a text prompt or an image is required");
      return {
        kind: "submit",
        model: model,
        action: worldPrompt.type === "text" ? "text_to_3d" : "image_to_3d",
        requestBody: { model: model, world_prompt: worldPrompt },
      };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const state = { status: status };
      if (status === "SUCCESS") {
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: responsesWorldText(ctx) }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE") return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status) return { events: [], state: state, done: false };
      return { events: [{ type: "progress", message: status.toLowerCase() }], state: state, done: false };
    },
    renderFinal: function (ctx) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesWorldText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "worldlabs" },
      };
    },
  },
};
