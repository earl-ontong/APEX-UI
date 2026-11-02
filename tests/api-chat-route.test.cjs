const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const routePath = path.join(__dirname, "..", "app", "api", "chat", "route.ts");
const routeSource = fs.readFileSync(routePath, "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadRoute(options) {
  const module = { exports: {} };
  const env = new Proxy({ NODE_ENV: options.nodeEnv }, {
    get(target, key) {
      if (key === "OPENAI_API_KEY") {
        return options.getApiKey ? options.getApiKey() : options.apiKey;
      }
      return target[key];
    },
  });
  const sandbox = {
    AbortSignal,
    DOMException,
    console,
    fetch: options.fetchImpl,
    process: { env },
    require(id) {
      if (id === "next/server") {
        return {
          NextResponse: {
            json(body, options = {}) {
              return { body, status: options.status ?? 200 };
            },
          },
        };
      }
      return require(id);
    },
  };
  const wrapper = vm.runInNewContext(Module.wrap(compiledRoute), sandbox, { filename: routePath });
  wrapper(module.exports, sandbox.require, module, __filename, __dirname);
  return module.exports;
}

test("production browser chat rejects before reading the API key or request body", async () => {
  let keyRead = false;
  const route = loadRoute({
    nodeEnv: "production",
    getApiKey() {
      keyRead = true;
      return "server-secret";
    },
  });
  const response = await route.POST({
    json() {
      assert.fail("production must reject before parsing the request body");
    },
  });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /Windows desktop app/);
  assert.equal(keyRead, false);
});

test("local development browser chat still proxies a valid chat request", async () => {
  let upstreamRequest;
  const route = loadRoute({
    nodeEnv: "development",
    apiKey: "dev-key",
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Hello from Apex." } }] }) };
    },
  });
  const response = await route.POST({
    json: async () => ({ messages: [{ role: "user", content: "Hello" }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reply, "Hello from Apex.");
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer dev-key");
});
