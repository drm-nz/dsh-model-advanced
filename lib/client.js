/**
 * dsh-model-advanced — browser half.
 *
 * Adds an "Advanced model settings" card to the Models settings page through
 * the page's `settings.models.footer` slot. Per model: the reasoning level it
 * starts at, and — for a model that cannot read images — the configured model
 * that reads them on its behalf.
 *
 * Both choices live in this plugin's own configuration namespace
 * (`model-advanced`), not in the adapters': only that way are two models on one
 * provider independent, and only that way do models the adapters cannot
 * describe still get a default.
 */
window.__ModuleLoader__.load({
  id: "dsh-model-advanced",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const styles = {
      card: {
        border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
        background: "var(--dsw-alias-settings-card-fill)",
        borderRadius: "var(--dsw-radius-xl)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        maxWidth: "720px",
        marginTop: "12px",
      },
      title: {
        margin: 0,
        fontSize: "16px",
        fontWeight: 500,
        lineHeight: "24px",
        color: "var(--dsw-alias-label-primary)",
      },
      hint: {
        margin: 0,
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      error: {
        margin: 0,
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-state-error-primary)",
      },
      row: {
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.1fr)",
        alignItems: "end",
        gap: "10px",
        padding: "8px 0",
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      },
      model: {
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      },
      modelName: {
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-primary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      id: {
        fontSize: "11px",
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      field: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minWidth: 0,
      },
      label: {
        fontSize: "11px",
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      select: {
        width: "100%",
        height: "30px",
        boxSizing: "border-box",
        border: "0.5px solid var(--dsw-alias-border-l4)",
        borderRadius: "var(--dsw-radius-md)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px",
        padding: "0 8px",
      },
      muted: {
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
      checkRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginTop: "2px",
      },
      value: {
        fontSize: "13px",
        lineHeight: "30px",
        color: "var(--dsw-alias-label-secondary)",
      },
    };

    /** The settings namespace this plugin owns. */
    const PLUGIN_NS = "model-advanced";

    function describeError(response) {
      return response.ok ? undefined : `${response.error.code}: ${response.error.message}`;
    }

    function valueAt(object, path) {
      let current = object;
      for (const key of path) {
        if (current === null || typeof current !== "object") return undefined;
        current = current[key];
      }
      return current;
    }

    function withTimeout(promise, ms) {
      return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms, undefined))]);
    }

    function modelKey(provider, model) {
      return `${provider}/${model}`;
    }

    /**
     * Modalities a provider's own configuration states for one model.
     * @param namespace - the provider's described settings namespace.
     * @param provider - configurable provider entry.
     * @param model - model id.
     * @returns modalities, or undefined when the configuration says nothing.
     */
    function configuredModalities(namespace, provider, model) {
      if (namespace === undefined || namespace.value === undefined) return undefined;
      const base = provider.settingsPath ?? [];
      const section = valueAt(namespace.value, base);
      if (section === null || typeof section !== "object") return undefined;
      if (namespace.ns === "llm-pi-ai") {
        const declared = Array.isArray(section.models) ? section.models.find((entry) => entry.id === model) : undefined;
        return declared === undefined ? undefined : Array.isArray(declared.input) ? declared.input : ["text"];
      }
      if (namespace.ns === "llm-deepseek") {
        const declared = Array.isArray(section.models) ? section.models.find((entry) => entry.id === model) : undefined;
        return declared === undefined ? undefined : Array.isArray(declared.inputModalities) ? declared.inputModalities : ["text"];
      }
      if (namespace.ns === "llm-deepseek-account") {
        const override = valueAt(section, ["modelOverrides", model]);
        return override !== null && typeof override === "object" && Array.isArray(override.inputModalities) ? override.inputModalities : undefined;
      }
      return undefined;
    }


    /**
     * Client plugin body.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      /** Render the advanced model settings card. */
      function AdvancedModelCard() {
        const [reloadKey, setReloadKey] = React.useState(0);
        const [snapshot, setSnapshot] = React.useState({ status: "loading" });
        const [busyKey, setBusyKey] = React.useState(undefined);
        const [notice, setNotice] = React.useState(undefined);

        React.useEffect(() => {
          let live = true;
          setSnapshot({ status: "loading" });
          (async () => {
            const [described, catalog, providers] = await Promise.all([
              ctx.remote.settings.describe(),
              ctx.remote.session.modelCatalog(),
              ctx.remote.llm.listConfigurableProviders(),
            ]);
            const failure = describeError(described) ?? describeError(catalog) ?? describeError(providers);
            if (failure !== undefined) throw new Error(failure);

            const namespaces = new Map(described.value.namespaces.map((entry) => [entry.ns, entry]));
            const byProvider = new Map(providers.value.map((entry) => [entry.provider, entry]));
            const pluginNamespace = namespaces.get(PLUGIN_NS);
            const rows = catalog.value.groups.flatMap((group) =>
              group.models.map((model) => {
                const provider = byProvider.get(group.id);
                const namespace = provider === undefined ? undefined : namespaces.get(provider.settingsNs);
                return {
                  key: modelKey(group.id, model.id),
                  providerId: group.id,
                  providerName: group.name,
                  model,
                  provider,
                  namespace,
                  modalities: provider === undefined ? undefined : configuredModalities(namespace, provider, model.id),
                };
              }),
            );

            // Ask the adapters only about models their configuration does not
            // describe, so an ordinary load stays offline.
            const unknownByProvider = new Map();
            for (const row of rows) {
              if (row.modalities !== undefined) continue;
              const entry = byProvider.get(row.providerId);
              if (entry === undefined) continue;
              const list = unknownByProvider.get(entry.settingsNs) ?? [];
              list.push({ entry, row });
              unknownByProvider.set(entry.settingsNs, list);
            }
            await Promise.all(
              [...unknownByProvider.values()].map(async (group) => {
                const entry = group[0].entry;
                try {
                  const response = await withTimeout(ctx.remote.llm.discoverModels(entry.settingsNs, { provider: entry.provider }), 12000);
                  if (response === undefined || !response.ok) return;
                  const byId = new Map(response.value.map((model) => [model.id, model.inputModalities]));
                  for (const { row } of group) {
                    const modalities = byId.get(row.model.id);
                    if (modalities !== undefined) row.modalities = modalities;
                  }
                } catch {
                  // A provider that refuses interrogation keeps unknown capabilities.
                }
              }),
            );

            // A provider whose catalog cannot be interrogated leaves its models
            // unknown; the same model id served by another configured route
            // still tells us what the adapter family supports.
            const knownById = new Map();
            for (const row of rows) {
              if (Array.isArray(row.modalities)) knownById.set(row.model.id, row.modalities);
            }
            for (const row of rows) {
              if (row.modalities !== undefined) continue;
              const inferred = knownById.get(row.model.id);
              if (inferred !== undefined) row.modalities = inferred;
            }

            return {
              rows,
              writable: described.value.writable,
              pluginNamespace,
              defaults: pluginNamespace === undefined ? {} : valueAt(pluginNamespace.value, ["modelDefaults"]) ?? {},
              delegates: pluginNamespace === undefined ? {} : valueAt(pluginNamespace.value, ["imageDelegates"]) ?? {},
              imageCapable: pluginNamespace === undefined ? {} : valueAt(pluginNamespace.value, ["imageCapable"]) ?? {},
            };
          })()
            .then((value) => {
              if (live) setSnapshot({ status: "ready", value });
            })
            .catch((error) => {
              if (live) setSnapshot({ status: "error", message: error instanceof Error ? error.message : String(error) });
            });
          return () => {
            live = false;
          };
        }, [reloadKey]);

        const save = async (namespace, ops, message) => {
          setNotice(undefined);
          try {
            const response = await ctx.remote.settings.mutate(namespace.ns, ops, namespace.revision);
            const failure = describeError(response);
            setNotice(failure === undefined ? { kind: "ok", text: message } : { kind: "error", text: failure });
          } catch (error) {
            setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
          } finally {
            setBusyKey(undefined);
            setReloadKey((key) => key + 1);
          }
        };

        const heading = h("h3", { style: styles.title }, "Advanced model settings");
        if (snapshot.status === "loading") {
          return h("section", { style: styles.card }, heading, h("p", { style: styles.hint }, "Loading models…"));
        }
        if (snapshot.status === "error") {
          return h("section", { style: styles.card }, heading, h("p", { style: styles.error }, snapshot.message));
        }

        const { rows, writable, pluginNamespace, defaults, delegates, imageCapable } = snapshot.value;
        const capabilityOf = (row) => {
          if (Object.hasOwn(imageCapable, row.key)) return imageCapable[row.key] === true;
          return Array.isArray(row.modalities) ? row.modalities.includes("image") : undefined;
        };
        const imageTargets = rows.filter((row) => capabilityOf(row) === true);
        const disabled = !writable || pluginNamespace === undefined;

        const chooseDefault = (row, level) => {
          if (pluginNamespace === undefined) return;
          setBusyKey(row.key);
          void save(
            pluginNamespace,
            [level === undefined
              ? { op: "unset", path: ["modelDefaults", row.key] }
              : { op: "set", path: ["modelDefaults", row.key], value: level }],
            `Saved ${row.model.name}.`,
          );
        };

        const chooseCapability = (row) => {
          if (pluginNamespace === undefined) return;
          setBusyKey(row.key);
          void save(pluginNamespace, [{ op: "set", path: ["imageCapable", row.key], value: true }], `${row.model.name} reads images.`);
        };

        const chooseDelegate = (row, target) => {
          if (pluginNamespace === undefined) return;
          setBusyKey(row.key);
          void save(
            pluginNamespace,
            [target === undefined
              ? { op: "unset", path: ["imageDelegates", row.key] }
              : { op: "set", path: ["imageDelegates", row.key], value: { provider: target.providerId, model: target.model.id } }],
            `Saved ${row.model.name}.`,
          );
        };

        return h(
          "section",
          { style: styles.card, "aria-label": "Advanced model settings" },
          heading,
          h("p", { style: styles.hint }, "Height of thought and eyes: the reasoning level a model starts at, and the model that reads images for one that cannot."),
          notice === undefined ? null : h("p", { style: notice.kind === "error" ? styles.error : styles.muted }, notice.text),
          !writable ? h("p", { style: styles.error }, "The settings document is read-only in this deployment.") : null,
          pluginNamespace === undefined ? h("p", { style: styles.error }, "This plugin's settings namespace is unavailable; restart the app to create it.") : null,
          rows.length === 0 ? h("p", { style: styles.hint }, "No models are configured.") : null,
          rows.map((row) => {
            const levels = row.model.reasoning === undefined ? [] : row.model.reasoning.efforts;
            const adapterDefault = row.model.reasoning === undefined ? undefined : row.model.reasoning.defaultEffort;
            const adapterName = adapterDefault === undefined ? undefined : levels.find((level) => level.id === adapterDefault)?.name ?? adapterDefault;
            const stored = defaults[row.key];
            const delegate = delegates[row.key];
            const delegateLabel = delegate === undefined ? "" : `${delegate.provider}/${delegate.model}`;
            const candidates = imageTargets.filter((target) => target.key !== row.key);
            const capability = capabilityOf(row);
            const readsImages = capability === true;
            return h(
              "div",
              { key: row.key, style: styles.row },
              h(
                "div",
                { style: styles.model },
                h("span", { style: styles.modelName, title: row.model.name }, row.model.name),
                h("span", { style: styles.id }, `${row.providerName} · ${row.model.id}`),
              ),
              h(
                "label",
                { style: styles.field },
                h("span", { style: styles.label }, "Default reasoning level"),
                h(
                  "select",
                  {
                    style: styles.select,
                    value: stored ?? "",
                    disabled: disabled || levels.length === 0 || busyKey === row.key,
                    onChange: (event) => {
                      const next = event.target.value;
                      chooseDefault(row, next === "" ? undefined : next);
                    },
                  },
                  h("option", { value: "" }, levels.length === 0 ? "This model offers no levels" : adapterName === undefined ? "No default" : `No default (adapter: ${adapterName})`),
                  levels.map((level) => h("option", { key: level.id, value: level.id }, level.name)),
                ),
              ),
              h(
                "div",
                { style: styles.field },
                h("span", { style: styles.label }, capability === undefined ? "Image understanding (capability unknown)" : "Image understanding"),
                readsImages
                  ? h("span", { style: styles.value }, "Reads images natively")
                  : h(
                      React.Fragment,
                      null,
                      candidates.length === 0
                        ? h("span", { style: styles.value }, "No image-capable model configured")
                        : h(
                            "select",
                            {
                              style: styles.select,
                              value: delegateLabel,
                              disabled: disabled || busyKey === row.key,
                              onChange: (event) => {
                                const next = event.target.value;
                                chooseDelegate(row, next === "" ? undefined : candidates.find((candidate) => candidate.key === next));
                              },
                            },
                            h("option", { value: "" }, "None"),
                            candidates.map((candidate) => h("option", { key: candidate.key, value: candidate.key }, `${candidate.providerName} · ${candidate.model.name}`)),
                          ),
                      capability === undefined
                        ? h(
                            "label",
                            { style: styles.checkRow },
                            h("input", {
                              type: "checkbox",
                              checked: false,
                              disabled: disabled || busyKey === row.key,
                              onChange: () => chooseCapability(row),
                            }),
                            h("span", { style: styles.label }, "This model reads images"),
                          )
                        : null,
                    ),
              ),
            );
          }),
        );
      }

      ctx.slots.inject("settings.models.footer", () =>
        ctx.slots.register(
          {
            name: "settings.models.footer",
            id: "model-advanced",
            order: 200,
          },
          AdvancedModelCard,
        ),
      );
    }

    return { apply, inject: ["slots", "remote", "remote.llm", "remote.settings", "remote.session"] };
  },
});
