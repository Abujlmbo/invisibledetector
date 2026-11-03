(function () {
  const { patcher, metro, storage, plugin } = vendetta;
  const { React, ReactNative } = metro.common;
  const { useProxy } = storage;
  const { View, Text, TextInput } = ReactNative;

  const store = plugin.storage;
  if (store.text === undefined) store.text = "1m";

  let unpatch = [];
  let hits = 0;

  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };

  const nameOf = (t) => {
    if (!t) return "";
    if (typeof t === "string") return t;
    return t.displayName || t.name || (t.type && nameOf(t.type)) || (t.render && nameOf(t.render)) || "";
  };

  const isNum = (v) => typeof v === "number" || (typeof v === "string" && /^\d+\+?$/.test(v));

  // يبدل الرقم بالنص قبل ما الكومبوننت يرسم
  function tweak(args) {
    const type = args[0], props = args[1];
    if (!props || typeof props !== "object") return;
    const n = nameOf(type);
    if (!/badge/i.test(n)) return;
    for (const k of ["count", "value", "number", "badgeCount", "mentionCount"]) {
      if (isNum(props[k])) {
        args[1] = Object.assign({}, props, { [k]: store.text });
        hits++;
        return;
      }
    }
  }

  // يمشي على الشجرة ويبدل أي رقم نصي
  function swap(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (isNum(node[i])) node[i] = store.text; else swap(node[i]);
      }
      return;
    }
    const p = node.props;
    if (!p) return;
    if (isNum(p.children)) p.children = store.text; else swap(p.children);
  }

  function Settings() {
    useProxy(store);
    return React.createElement(
      View, { style: { padding: 16 } },
      React.createElement(Text, { style: { color: "#fff", marginBottom: 8 } }, "النص اللي يطلع بدل الرقم:"),
      React.createElement(TextInput, {
        value: store.text,
        onChangeText: (v) => (store.text = v),
        placeholder: "1m",
        placeholderTextColor: "#888",
        style: { color: "#fff", backgroundColor: "#2b2d31", borderRadius: 8, padding: 10, fontSize: 18 },
      }),
      React.createElement(Text, { style: { color: "#aaa", marginTop: 8 } }, "اعمل ريلود للتطبيق عشان يتحدث الشكل.")
    );
  }

  return {
    onLoad() {
      // 1) باتش على الكومبوننتات المعروفة
      for (const name of ["NumberBadge", "Badge", "BadgeComponent", "MentionBadge", "GuildBadge"]) {
        const mod = safe(() => metro.findByName(name, false));
        if (mod && typeof mod.default === "function") {
          unpatch.push(patcher.after("default", mod, (a, res) => { safe(() => swap(res)); return res; }));
        }
      }
      // 2) باتش على إنشاء العناصر (يشتغل حتى لو الاسم مختلف)
      const jsx = safe(() => metro.findByProps("jsx", "jsxs"));
      if (jsx) {
        for (const k of ["jsx", "jsxs"]) {
          if (typeof jsx[k] === "function") unpatch.push(patcher.before(k, jsx, (args) => { safe(() => tweak(args)); }));
        }
      }
      if (typeof React.createElement === "function") {
        unpatch.push(patcher.before("createElement", React, (args) => { safe(() => tweak(args)); }));
      }
      safe(() => vendetta.ui.toasts.showToast("FakeBadge: شغال، اعمل ريلود"));
    },
    onUnload() {
      unpatch.forEach((u) => safe(u));
      unpatch = [];
    },
    settings: Settings,
  };
})()
