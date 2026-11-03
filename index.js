(function () {
  const { patcher, metro, storage, plugin } = vendetta;
  const { React, ReactNative } = metro.common;
  const { useProxy } = storage;
  const { View, Text, TextInput, ScrollView } = ReactNative;

  const store = plugin.storage;
  if (store.text === undefined) store.text = "1m";

  let unpatch = [];
  const seen = {};

  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };

  const nameOf = (t) => {
    if (!t) return "";
    if (typeof t === "string") return t;
    return t.displayName || t.name || (t.type && nameOf(t.type)) || (t.render && nameOf(t.render)) || "(anon)";
  };

  const isNum = (v) => typeof v === "number" || (typeof v === "string" && /^\d+\+?$/.test(v));
  const KEY = /count|number|badge|mention|unread|notif/i;

  function tweak(args) {
    const type = args[0], props = args[1];
    if (!props || typeof props !== "object" || typeof type === "string") return;
    const n = nameOf(type);
    for (const k of Object.keys(props)) {
      if (KEY.test(k) && isNum(props[k])) {
        seen[n + " ." + k] = props[k];
        if (/badge/i.test(n)) {
          args[1] = Object.assign({}, props, { [k]: store.text });
        }
      }
    }
  }

  function Settings() {
    useProxy(store);
    const [, force] = React.useState(0);
    const rows = Object.keys(seen).map((k) => k + " = " + seen[k]);
    return React.createElement(
      ScrollView, { style: { padding: 16 } },
      React.createElement(Text, { style: { color: "#fff", marginBottom: 8 } }, "النص اللي يطلع بدل الرقم:"),
      React.createElement(TextInput, {
        value: store.text,
        onChangeText: (v) => (store.text = v),
        placeholderTextColor: "#888",
        style: { color: "#fff", backgroundColor: "#2b2d31", borderRadius: 8, padding: 10, fontSize: 18 },
      }),
      React.createElement(Text, { onPress: () => force((x) => x + 1), style: { color: "#5865f2", marginTop: 16, fontSize: 16 } }, "تحديث القائمة (اضغط)"),
      React.createElement(Text, { style: { color: "#aaa", marginTop: 8 } }, "تشخيص: كومبوننتات فيها عدد:"),
      React.createElement(Text, { selectable: true, style: { color: "#fff", marginTop: 4 } }, rows.length ? rows.join("\n") : "(ما لقيت شي)")
    );
  }

  return {
    onLoad() {
      const jsx = safe(() => metro.findByProps("jsx", "jsxs"));
      if (jsx) {
        for (const k of ["jsx", "jsxs"]) {
          if (typeof jsx[k] === "function") unpatch.push(patcher.before(k, jsx, (args) => { safe(() => tweak(args)); }));
        }
      }
      if (typeof React.createElement === "function") {
        unpatch.push(patcher.before("createElement", React, (args) => { safe(() => tweak(args)); }));
      }
      safe(() => vendetta.ui.toasts.showToast("FakeBadge v3 شغال"));
    },
    onUnload() {
      unpatch.forEach((u) => safe(u));
      unpatch = [];
    },
    settings: Settings,
  };
})()
