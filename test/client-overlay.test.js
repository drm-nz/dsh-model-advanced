import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The browser half runs inside the Web client's module loader, which is not
 * available here. This loads it through a fake loader with a minimal hooks
 * runtime, which is enough to assert what it registers and what it renders.
 */

/** Fresh module instance per call: the module caches its check and its imports. */
async function loadPlugin({ withPrimitives, requireOverride }) {
  let factory;
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory; } },
  };
  const url = new URL(`../lib/client.js?case=${Math.random()}`, import.meta.url);
  await import(url.href);
  assert.ok(factory, "the loader captured the plugin factory");

  const toastCalls = [];
  const fakeToast = (props) => { toastCalls.push(props); return { type: "Toast", props }; };
  const primitives = { Toast: fakeToast, IconWarningOutlineRegular: () => null };

  const plugin = factory((name) => {
    if (name === "react") return requireOverride.react;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      if (!withPrimitives) throw new Error("absent in this build");
      return primitives;
    }
    throw new Error(`unexpected require: ${name}`);
  });
  return { plugin, toastCalls, fakeToast };
}

/** Minimal hooks runtime: stable state across renders, effects collected. */
function hooksRuntime() {
  let slot = 0;
  let states = [];
  let effects = [];
  const react = {
    Fragment: "Fragment",
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const i = slot++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (value) => { states[i] = value; }];
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: (callback) => { effects.push(callback); },
  };
  return {
    react,
    /** Render once, returning the tree and the effects that render queued. */
    render(Component) {
      slot = 0;
      effects = [];
      const tree = Component({});
      const queued = effects.slice();
      effects = [];
      return { tree, queued };
    },
  };
}

function ctxWithCatalog({ configured, reported, primitivesAvailable }) {
  const ctx = {
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, Component) => { ctx.registration = { options, Component }; return () => {}; },
    },
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            writable: true,
            namespaces: [{
              ns: "model-advanced",
              revision: 1,
              value: { modelDefaults: { "deepseek/deepseek-flash": configured } },
            }],
          },
        }),
      },
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: {
            groups: [{
              id: "deepseek",
              name: "DeepSeek",
              models: [{
                id: "deepseek-flash",
                name: "DeepSeek-V4.1-Flash",
                reasoning: { efforts: [{ id: "low" }, { id: "max" }], defaultEffort: reported },
              }],
            }],
          },
        }),
      },
    },
  };
  return ctx;
}

/** Apply the plugin and return a render helper bound to its overlay entry. */
async function subject(options) {
  const { react, render } = hooksRuntime();
  const { plugin, toastCalls, fakeToast } = await loadPlugin({ withPrimitives: options.withPrimitives, requireOverride: { react } });
  const ctx = ctxWithCatalog(options);
  plugin.apply(ctx);
  assert.equal(ctx.registration.options.name, "conversation.input.overlay");
  assert.equal(ctx.registration.options.id, "model-advanced-health");
  const Component = ctx.registration.Component;

  const first = render(Component);
  assert.equal(first.tree, null, "nothing is rendered before the check resolves");
  first.queued.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = render(Component);
  second.queued.forEach((effect) => effect());
  const third = render(Component);
  return { tree: third.tree, toastCalls, fakeToast };
}

test("registers one entry in the composer overlay", async () => {
  const { plugin } = await loadPlugin({
    withPrimitives: true,
    requireOverride: { react: hooksRuntime().react },
  });
  assert.deepEqual(plugin.inject.slice().sort(), [
    "remote",
    "remote.llm",
    "remote.session",
    "remote.settings",
    "slots",
  ]);
});

test("renders nothing when the configured default is being applied", async () => {
  const { tree } = await subject({ configured: "max", reported: "max", withPrimitives: true });
  assert.equal(tree, null);
});

test("warns through the shared Toast when the default is not applied", async () => {
  const { tree, toastCalls, fakeToast } = await subject({ configured: "max", reported: "low", withPrimitives: true });
  assert.ok(tree, "a warning is rendered");
  const content = tree.children[1];
  assert.equal(content.type, fakeToast, "the shared Toast primitive is used");
  assert.equal(content.props.tone, "warning");
  assert.equal(content.props.holdMs, 10000);
  assert.match(content.props.text, /not applying 1 of 1/);
  assert.match(content.props.text, /Harness upgrade/);
  assert.equal(toastCalls.length, 0, "the Toast is described, not invoked during render");
});

test("falls back to a red alert bar when the Toast primitive is absent", async () => {
  const { tree } = await subject({ configured: "max", reported: "low", withPrimitives: false });
  assert.ok(tree, "a warning is rendered");
  const content = tree.children[1];
  assert.equal(content.props.role, "alert");
  assert.match(content.props.style.color, /state-error/);
  assert.match(JSON.stringify(content.children), /not applying 1 of 1/);
});
