/**
 * dsh-model-advanced — host half.
 *
 * Two capabilities the adapters cannot express themselves:
 *
 * - per-model default reasoning effort (`modelDefaults`), applied to the model
 *   catalogue and to selections that never named an effort;
 * - image handoff (`imageDelegates`): a text-only model borrows a configured
 *   multimodal model to read an image, and can ask it further questions later
 *   through the `inspect_image` tool.
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name. */
export const name = "model-advanced";

/** Services this plugin reads directly. */
export const inject = ["llm", "agentDefaultModel", "tools"];

/** Fields the Models page's Advanced card edits. */
export const Config = z.object({
  modelDefaults: z.dict(z.string()).default({}).volatile(),
  imageDelegates: z.dict(z.object({ provider: z.string(), model: z.string() })).default({}).volatile(),
  imageCapable: z.dict(z.boolean()).default({}).volatile(),
});

/** Instruction that turns a vision model into a layout-preserving reader. */
const TRANSCRIPTION_INSTRUCTION = [
  "You are reading an image on behalf of a model that cannot see images.",
  "Return one Markdown document, in this order:",
  "1. a one-line summary of the image;",
  "2. the reading order (top-to-bottom, left-to-right unless the layout says otherwise);",
  "3. every text region: a heading, its approximate bounding box as x1,y1,x2,y2 on a 0-1000 scale, and its exact text;",
  "4. every table as a GFM table with its region box and, when present, its caption and header row;",
  "5. notes for diagrams, charts, UI state, or handwriting that text alone would lose.",
  "Do not paraphrase text. Do not add commentary or apologies.",
].join("\n");

/** Prefix carried by every handoff note, used to recognise one already made. */
const NOTE_MARK = "[dsh-image-handoff:";

/**
 * Register the plugin.
 * @param ctx - plugin context.
 * @param config - parsed configuration references.
 */
export function apply(ctx, config) {
  const defaults = () => config.modelDefaults.get() ?? {};
  const delegates = () => config.imageDelegates.get() ?? {};
  const keyOf = (provider, model) => `${provider}/${model}`;

  // Which provider/model each agent is running. Prompt assembly runs before the
  // pre-step waterfall and carries the selected route as variables.
  const routes = new WeakMap();
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    try {
      if (context.agent !== undefined) {
        const provider = assembled?.variables?.provider;
        const model = assembled?.variables?.model;
        if (typeof provider === "string" && typeof model === "string") routes.set(context.agent.session, { provider, model });
      }
    } catch {
      // Route tracking must never break prompt assembly.
    }
    return assembled;
  });

  // 1. Catalogue decoration: the picker states the configured default, and a
  // model that has a delegate is allowed to receive an image so the prompt
  // admission check passes. The wire stays text-only: dispatch reads the
  // adapter's own capability and projects the image to a placeholder.
  try {
    const llm = ctx.llm;
    const proto = Object.getPrototypeOf(llm);
    const original = proto.resolveModelInfo;
    if (typeof original !== "function") throw new Error("resolveModelInfo is not a prototype method");
    const decorate = (info, provider, model) => {
      if (info === null || typeof info !== "object") return info;
      let next = info;
      const level = defaults()[keyOf(provider, model)];
      if (level !== undefined && info.reasoning !== undefined && info.reasoning.efforts.some((effort) => effort.id === level)) {
        next = { ...next, reasoning: { ...next.reasoning, defaultEffort: level } };
      }
      const delegate = delegates()[keyOf(provider, model)];
      const modalities = next.inputModalities;
      if (delegate !== undefined && modalities !== undefined && !modalities.includes("image")) {
        next = { ...next, inputModalities: [...modalities, "image"] };
      }
      return next;
    };
    const wrapped = async function resolveModelInfo(provider, model, signal) {
      const info = await original.call(this, provider, model, signal);
      return decorate(info, provider, model);
    };
    proto.resolveModelInfo = wrapped;

    // A model switch names no effort; the selection is then filled from the
    // adapter's default here. Materialize the configured default instead.
    const originalCall = proto.resolveCallConfig;
    if (typeof originalCall !== "function") throw new Error("resolveCallConfig is not a prototype method");
    const wrappedCall = async function resolveCallConfig(callConfig, signal) {
      const resolved = await originalCall.call(this, callConfig, signal);
      if (callConfig.reasoningEffort !== undefined) return resolved;
      const level = defaults()[keyOf(callConfig.provider, callConfig.model)];
      if (level === undefined) return resolved;
      return { ...resolved, reasoningEffort: level };
    };
    proto.resolveCallConfig = wrappedCall;

    ctx.effect(() => () => {
      if (proto.resolveModelInfo === wrapped) proto.resolveModelInfo = original;
      if (proto.resolveCallConfig === wrappedCall) proto.resolveCallConfig = originalCall;
    });
  } catch (error) {
  }

  // 2. Requests that never picked a level take the model's configured default.
  try {
    ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      if (resolved.reasoningEffort !== undefined) return resolved;
      const level = defaults()[keyOf(resolved.provider, resolved.model)];
      if (level === undefined) return resolved;
      try {
        const info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model);
        if (info.reasoning === undefined || !info.reasoning.efforts.some((effort) => effort.id === level)) return resolved;
      } catch {
        return resolved;
      }
      return { ...resolved, reasoningEffort: level };
    });
  } catch (error) {
  }

  // 3. Hand an image to the configured delegate once, and note the extraction
  // in the conversation so the text-only model keeps it in later turns.
  const transcribe = async (delegate, attachment, question, signal) => {
    const call = await ctx.llm.prepareCall({ provider: delegate.provider, model: delegate.model }, signal);
    const instruction = question === undefined
      ? TRANSCRIPTION_INSTRUCTION
      : `${TRANSCRIPTION_INSTRUCTION}\n\nAnswer this about the image, using the structure above:\n${question}`;
    const message = createUserMessage({
      content: [
        { type: "text", text: instruction },
        { type: "image", attachment },
      ],
      source: { kind: "context", form: "image-handoff", summary: "image handoff" },
    });
    let text = "";
    for await (const chunk of call.stream({
      ...call.config,
      messages: [message],
      tools: [],
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
        throw new Error(`handoff to ${delegate.provider}/${delegate.model} failed: ${chunk.reason.failure?.code ?? "ERROR"}`);
      }
    }
    return text.trim();
  };

  const imageBlocks = (messages) => {
    const found = [];
    for (const message of messages) {
      for (const block of message.content ?? []) {
        if (block.type === "image" && block.attachment !== undefined) found.push(block.attachment);
      }
    }
    return found;
  };

  const noted = (session) => {
    const marks = new Set();
    try {
      for (const message of session.deriveMessages()) {
        for (const block of message.content ?? []) {
          if (block.type !== "text" || typeof block.text !== "string") continue;
          for (const match of block.text.matchAll(/\[dsh-image-handoff:([^\]]+)\]/g)) marks.add(match[1]);
        }
      }
    } catch {
      // A session whose history cannot be read simply repeats the handoff.
    }
    return marks;
  };

  const handoffNote = (attachmentId, provider, model, text) => createUserMessage({
    content: [{
      type: "text",
      text: [
        `Image transcript (read by ${provider}/${model} on this model's behalf).`,
        `Image id: ${attachmentId}`,
        text,
        `To ask this image another question, call inspect_image with image_id "${attachmentId}".`,
        `${NOTE_MARK}${attachmentId}]`,
      ].join("\n\n"),
    }],
    source: { kind: "context", form: "image-handoff", summary: `image transcript via ${provider}/${model}` },
  });

  const routeOf = (agent) => routes.get(agent.session)
    ?? agent.session.requestHeader()?.config
    ?? ctx.agentDefaultModel.currentSelection();

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    try {
      const route = routeOf(payload.agent);
      if (route === undefined) return decision;
      const delegate = delegates()[keyOf(route.provider, route.model)];
      if (delegate === undefined) return decision;
      if (delegate.provider === route.provider && delegate.model === route.model) return decision;
      const images = imageBlocks(payload.messages);
      if (images.length === 0) return decision;
      const seen = noted(payload.agent.session);
      const notes = [];
      for (const attachment of images) {
        const id = String(attachment.attachmentId);
        if (seen.has(id)) continue;
        try {
          const text = await transcribe(delegate, attachment, undefined, payload.signal);
          if (text.length > 0) notes.push(handoffNote(id, delegate.provider, delegate.model, text));
        } catch (error) {
          notes.push(handoffNote(id, delegate.provider, delegate.model, `The delegate could not read this image: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (notes.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, ...notes] };
    } catch {
      // Handoff is best-effort: a failure leaves the turn exactly as it was.
      return decision;
    }
  });

  const findImage = (session, id) => {
    for (const message of session.deriveMessages()) {
      for (const block of message.content ?? []) {
        if (block.type === "image" && String(block.attachment?.attachmentId) === id) return block.attachment;
      }
    }
    return undefined;
  };

  // 4. A tool for later questions: hand the image to the delegate again.
  try {
    ctx.tools.register(defineTool({
      name: "inspect_image",
      description: "Ask the image-reading delegate another question about an image already in this conversation. Use it when the transcript noted earlier does not answer a question and the image itself holds the answer. Pass the image id from the transcript note.",
      parameters: {
        image_id: {
          type: "string",
          required: true,
          description: "The image id printed in the transcript note, for example attachment:abc123.",
        },
        question: {
          type: "string",
          required: true,
          description: "What to find out from the image, as precisely as possible.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("inspect_image requires an agent Session");
        const route = routeOf(exec.agent);
        if (route === undefined) throw new Error("inspect_image cannot tell which model is running");
        const delegate = delegates()[keyOf(route.provider, route.model)];
        if (delegate === undefined) throw new Error("no image delegate is configured for this model");
        const attachment = findImage(exec.agent.session, args.image_id);
        if (attachment === undefined) throw new Error(`no image with id "${args.image_id}" is in this conversation`);
        const text = await transcribe(delegate, attachment, args.question, exec.signal);
        return { text };
      },
    }));
  } catch (error) {
  }

  // 5. Align the global default selection with the configured default, once the
  // composition transaction has settled (a write inside it is refused).
  const reconcile = async () => {
    try {
      const selection = ctx.agentDefaultModel.currentSelection();
      const level = defaults()[keyOf(selection.provider, selection.model)];
      if (level === undefined || selection.reasoningEffort === level) return;
      await ctx.agentDefaultModel.saveSelection({ ...selection, reasoningEffort: level });
    } catch (error) {
    }
  };
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void reconcile();
    }, 1500);
    return () => clearTimeout(timer);
  });

}
