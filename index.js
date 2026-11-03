(function () {
  const { patcher, metro, storage, plugin, ui } = vendetta;
  const { React, ReactNative } = metro.common;
  const { useProxy } = storage;
  const { View, Text, TextInput, Switch } = ReactNative;

  const store = plugin.storage;
  if (store.text === undefined) store.text = "1m";
  if (store.onlyBig === undefined) store.onlyBig = false;

  let unpatch = [];

  // يمشي على الشجرة ويبدل أي رقم بالنص حقك
  function swap(node, seen) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const c = node[i];
        if (typeof c === "number" || (typeof c === "string" && /^\d+\+?$/.test(c))) {
          node[i] = store.text;
        } else swap(c);
      }
      return;
    }
    const p = node.props;
    if (!p) return;
    const ch = p.children;
    if (typeof ch === "number" || (typeof ch === "string" && /^\d+\+?$/.test(ch))) {
      p.children = store.text;
    } else swap(ch);
  }

  function Settings() {
    useProxy(store);
    return React.createElement(
      View,
      { style: { padding: 16 } },
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
      const mod = metro.findByName("NumberBadge", false);
      if (!mod) {
        vendetta.ui.toasts.showToast("FakeBadge: ما لقيت كومبوننت البادج");
        return;
      }
      unpatch.push(
        patcher.after("default", mod, (args, res) => {
          try { swap(res); } catch (e) {}
          return res;
        })
      );
    },
    onUnload() {
      unpatch.forEach((u) => u());
      unpatch = [];
    },
    settings: Settings,
  };
})()
