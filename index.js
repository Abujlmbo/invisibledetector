(function () {
  "use strict";

  /* InvisibleDetector — Revenge / Bunny (Vendetta API)
   * ملاحظة: لا تحط أي شي قبل أول سطر في الملف، لأن ريفينج يضيف return قبله. */

  /* ───────────── واجهة ريفينج ───────────── */

  var metro = vendetta.metro;
  var common = metro.common;
  var storage = vendetta.plugin.storage;
  var useProxy = vendetta.storage.useProxy;
  var Forms = vendetta.ui.components.Forms;
  var showToast = vendetta.ui.toasts.showToast;
  var registerCommand = vendetta.commands.registerCommand;

  var FluxDispatcher = common.FluxDispatcher;
  var React = common.React;
  var ReactNative = common.ReactNative;

  var UserStore = metro.findByStoreName("UserStore");
  var ChannelStore = metro.findByStoreName("ChannelStore");
  var GuildStore = metro.findByStoreName("GuildStore");
  var GuildMemberStore = metro.findByStoreName("GuildMemberStore");
  var PresenceStore = metro.findByStoreName("PresenceStore");
  var RelationshipStore = metro.findByStoreName("RelationshipStore");
  var messageUtil = metro.findByProps("sendBotMessage");

  /* ───────────── الإعدادات ───────────── */

  var DEFAULTS = {
    friendsOnly: true,
    cooldownMinutes: 10,
    anniversaryNotify: true,
    hiddenWindowMinutes: 10
  };

  function cfg() {
    return storage.settings;
  }

  /* ───────────── رموز ───────────── */

  var EMOJI = {
    online: "🟢",
    idle: "🌙",
    dnd: "⛔",
    offline: "⚫",
    warn: "⚠️",
    voice: "🔊",
    party: "🎉"
  };

  /* ───────────── البيانات ───────────── */

  var MAX_PER_USER = 60;

  function emptyData() {
    return {
      lastSeen: {},
      lastOnline: {},
      profiles: {},
      changes: {},
      voice: {},
      exposed: [],
      lastAnniversaryCheck: ""
    };
  }

  var data = emptyData();
  var ready = false;
  var dirty = false;
  var flushTimer = null;
  var annivTimer = null;
  var unregisterCommand = null;

  var currentVoice = new Map();
  var lastAlert = new Map();

  function flush() {
    if (!dirty || !ready) return;
    dirty = false;
    try {
      // مرجع جديد عشان يتحفظ في التخزين
      storage.data = Object.assign({}, data);
    } catch (e) {
      dirty = true;
      console.error("[InvisibleDetector] save failed", e);
    }
  }

  /* ───────────── أدوات مساعدة ───────────── */

  function nameOf(id) {
    var u = UserStore.getUser(id);
    if (u && u.globalName) return u.globalName;
    if (u && u.username) return u.username;
    return id;
  }

  function fmtDate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function ago(ts) {
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "الحين";
    if (m < 60) return "قبل " + m + " دقيقة";
    var h = Math.floor(m / 60);
    if (h < 24) return "قبل " + h + " ساعة";
    return "قبل " + Math.floor(h / 24) + " يوم";
  }

  function dur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + " دقيقة";
    return (m / 60).toFixed(1) + " ساعة";
  }

  function describeLocation(channelId) {
    if (!channelId) return "مكان غير معروف";
    var channel = ChannelStore.getChannel(channelId);
    if (!channel) return "مكان غير معروف";

    if (!channel.guild_id) {
      return channel.type === 3 ? "مجموعة خاصة" : "رسائل خاصة (DM)";
    }

    var guild = GuildStore.getGuild(channel.guild_id);
    var isVoice = channel.type === 2 || channel.type === 13;
    var name = isVoice ? EMOJI.voice + " " + channel.name : "#" + channel.name;
    var guildName = guild && guild.name ? guild.name : "سيرفر";
    return guildName + " › " + name;
  }

  function isTracked(userId) {
    if (!userId || !ready) return false;
    var me = UserStore.getCurrentUser();
    if (!me || userId === me.id) return false;
    if (cfg().friendsOnly && !RelationshipStore.isFriend(userId)) return false;
    var u = UserStore.getUser(userId);
    if (u && u.bot) return false;
    return true;
  }

  /* ───────────── تسجيل النشاط وكشف الأوفلاين ───────────── */

  function activity(userId, action, channelId) {
    if (!userId || !isTracked(userId)) return;

    var where = describeLocation(channelId);
    var now = Date.now();
    data.lastSeen[userId] = { ts: now, action: action, where: where };
    dirty = true;

    // حالته الظاهرة لك "أوفلاين" لكنه سوّا نشاط فعلي
    if (PresenceStore.getStatus(userId) !== "offline") return;

    var cooldown = Math.max(1, Number(cfg().cooldownMinutes) || 10) * 60000;
    var prev = lastAlert.get(userId) || 0;
    if (now - prev < cooldown) return;
    lastAlert.set(userId, now);

    data.exposed.push({ ts: now, userId: userId, action: action, where: where });
    if (data.exposed.length > 100) {
      data.exposed.splice(0, data.exposed.length - 100);
    }

    showToast(nameOf(userId) + " حالته أوفلاين وهو اونلاين\n" + action + " — " + where);
  }

  /* ───────────── تاريخ التغييرات ───────────── */

  function logChange(userId, text) {
    if (!data.changes[userId]) data.changes[userId] = [];
    var arr = data.changes[userId];
    arr.push({ ts: Date.now(), text: text });
    if (arr.length > MAX_PER_USER) arr.splice(0, arr.length - MAX_PER_USER);
    dirty = true;
  }

  function noteUser(u) {
    if (!u || !u.id || !isTracked(u.id)) return;

    var prev = data.profiles[u.id];

    var globalName;
    if (u.global_name !== undefined) globalName = u.global_name;
    else if (u.globalName !== undefined) globalName = u.globalName;
    else globalName = prev ? prev.globalName : undefined;

    var next = {
      username: u.username !== undefined && u.username !== null ? u.username : (prev ? prev.username : undefined),
      globalName: globalName,
      avatar: u.avatar !== undefined ? u.avatar : (prev ? prev.avatar : undefined)
    };

    if (prev) {
      if (prev.username !== undefined && prev.username !== next.username) {
        logChange(u.id, "غيّر اسم المستخدم: " + prev.username + " ← " + next.username);
      }
      if (prev.globalName !== undefined && prev.globalName !== next.globalName) {
        var from = prev.globalName === null || prev.globalName === undefined ? "(بدون)" : prev.globalName;
        var to = next.globalName === null || next.globalName === undefined ? "(بدون)" : next.globalName;
        logChange(u.id, "غيّر الاسم المعروض: " + from + " ← " + to);
      }
      if (prev.avatar !== undefined && prev.avatar !== next.avatar) {
        logChange(u.id, "غيّر صورته الشخصية");
      }
    }

    data.profiles[u.id] = next;
    dirty = true;
  }

  /* ───────────── الرومات الصوتية ───────────── */

  function endVoice(userId) {
    var cur = currentVoice.get(userId);
    if (!cur) return;
    currentVoice.delete(userId);

    if (!data.voice[userId]) data.voice[userId] = [];
    var arr = data.voice[userId];
    arr.push({ start: cur.start, end: Date.now(), where: cur.where });
    if (arr.length > MAX_PER_USER) arr.splice(0, arr.length - MAX_PER_USER);
    dirty = true;
  }

  /* ───────────── ذكرى الصداقة ───────────── */

  function sinceOf(id) {
    var s = RelationshipStore.getSince ? RelationshipStore.getSince(id) : null;
    return s ? new Date(s) : null;
  }

  function checkAnniversaries() {
    if (!ready || !cfg().anniversaryNotify) return;

    var today = new Date();
    var key = today.toDateString();
    if (data.lastAnniversaryCheck === key) return;
    data.lastAnniversaryCheck = key;
    dirty = true;

    var ids = RelationshipStore.getFriendIDs();
    for (var i = 0; i < ids.length; i++) {
      var d = sinceOf(ids[i]);
      if (!d) continue;
      var years = today.getFullYear() - d.getFullYear();
      if (years >= 1 && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
        showToast(EMOJI.party + " اليوم صار لك " + years + " " + (years === 1 ? "سنة" : "سنوات") + " مع " + nameOf(ids[i]));
      }
    }
  }

  /* ───────────── حالة الاونلاين الحين ───────────── */

  function statusLabel(status) {
    if (status === "online") return EMOJI.online + " اونلاين";
    if (status === "idle") return EMOJI.idle + " خامل";
    if (status === "dnd") return EMOJI.dnd + " مشغول (لا تزعج)";
    return EMOJI.offline + " أوفلاين";
  }

  function platformsOf(id) {
    try {
      if (!PresenceStore.getClientStatus) return "";
      var cs = PresenceStore.getClientStatus(id);
      if (!cs) return "";
      var out = [];
      if (cs.mobile) out.push("جوال");
      if (cs.desktop) out.push("كمبيوتر");
      if (cs.web) out.push("متصفح");
      return out.join(" + ");
    } catch (e) {
      return "";
    }
  }

  // يرجّع حالته الظاهرة + هل هو "مخفي" (يظهر أوفلاين لكن نشاطه حديث)
  function onlineInfo(id) {
    var status = PresenceStore.getStatus(id);
    var appearsOffline = !status || status === "offline" || status === "invisible";
    var seen = data.lastSeen[id];
    var windowMs = Math.max(1, Number(cfg().hiddenWindowMinutes) || 10) * 60000;
    var hidden = appearsOffline && !!seen && Date.now() - seen.ts < windowMs;
    return {
      status: status,
      appearsOffline: appearsOffline,
      hidden: hidden,
      seen: seen,
      platforms: platformsOf(id),
      lastOnline: data.lastOnline[id]
    };
  }

  function sectionOnline(userId) {
    var info, line;

    if (userId) {
      info = onlineInfo(userId);
      line = "**" + nameOf(userId) + "**: ";

      if (info.hidden) {
        line += EMOJI.online + " اونلاين الحين (مخفي)";
      } else {
        line += statusLabel(info.status);
      }

      if (info.platforms && !info.appearsOffline) line += " — من " + info.platforms;

      if (info.hidden) {
        line += "\n" + EMOJI.warn + " يظهر أوفلاين لكن آخر نشاط " + ago(info.seen.ts) +
          " (" + info.seen.action + ") في " + info.seen.where;
      } else if (info.appearsOffline) {
        if (info.seen) line += "\n• آخر نشاط: " + ago(info.seen.ts) + " (" + info.seen.action + ")";
        if (info.lastOnline) line += "\n• آخر مرة شفته اونلاين: " + ago(info.lastOnline);
        if (!info.seen && !info.lastOnline) line += "\n• ما سجلت له أي ظهور بعد.";
      }
      return line;
    }

    var ids = RelationshipStore.getFriendIDs();
    var online = [];
    var hiddenList = [];

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var inf = onlineInfo(id);
      if (inf.hidden) {
        hiddenList.push("• **" + nameOf(id) + "** — " + ago(inf.seen.ts) + " (" + inf.seen.action + ")");
      } else if (!inf.appearsOffline) {
        var p = inf.platforms ? " — " + inf.platforms : "";
        online.push("• " + statusLabel(inf.status).split(" ")[0] + " **" + nameOf(id) + "**" + p);
      }
    }

    var out = "**الاونلاين الحين (" + online.length + "):**\n" +
      (online.length ? online.slice(0, 25).join("\n") : "ما أحد.");

    if (hiddenList.length) {
      out += "\n\n" + EMOJI.warn + " **يظهرون أوفلاين وهم نشطين (" + hiddenList.length + "):**\n" +
        hiddenList.slice(0, 15).join("\n");
    }
    return out;
  }

  /* ───────────── أقسام أمر /invisible ───────────── */

  function sectionLastSeen(userId) {
    if (userId) {
      var e = data.lastSeen[userId];
      if (!e) return "**" + nameOf(userId) + "**: ما سجلت له نشاط بعد.";
      return "**" + nameOf(userId) + "** آخر نشاط " + ago(e.ts) + " (" + e.action + ") في " + e.where;
    }
    var rows = Object.entries(data.lastSeen)
      .sort(function (a, b) { return b[1].ts - a[1].ts; })
      .slice(0, 15)
      .map(function (p) {
        return "• **" + nameOf(p[0]) + "**: " + ago(p[1].ts) + " — " + p[1].action + " (" + p[1].where + ")";
      });
    return rows.length ? "**آخر ظهور:**\n" + rows.join("\n") : "ما فيه سجل بعد.";
  }

  function sectionChanges(userId) {
    if (userId) {
      var arr = (data.changes[userId] || []).slice(-15).reverse();
      if (!arr.length) return "ما سجلت أي تغيير لـ " + nameOf(userId) + ".";
      var lines = arr.map(function (c) { return "• " + fmtDate(c.ts) + ": " + c.text; });
      return "**تغييرات " + nameOf(userId) + ":**\n" + lines.join("\n");
    }
    var all = [];
    Object.keys(data.changes).forEach(function (id) {
      data.changes[id].forEach(function (c) {
        all.push({ id: id, ts: c.ts, text: c.text });
      });
    });
    all.sort(function (a, b) { return b.ts - a.ts; });
    var rows = all.slice(0, 15).map(function (c) {
      return "• " + fmtDate(c.ts) + " **" + nameOf(c.id) + "**: " + c.text;
    });
    return rows.length ? "**آخر التغييرات:**\n" + rows.join("\n") : "ما سجلت أي تغيير بعد.";
  }

  function totalOf(arr) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i].end - arr[i].start;
    return t;
  }

  function sectionVoice(userId) {
    if (userId) {
      var arr = data.voice[userId] || [];
      if (!arr.length) return "ما سجلت جلسات صوتية لـ " + nameOf(userId) + ".";

      var byPlace = new Map();
      arr.forEach(function (x) {
        byPlace.set(x.where, (byPlace.get(x.where) || 0) + (x.end - x.start));
      });
      var top = Array.from(byPlace.entries()).sort(function (a, b) { return b[1] - a[1]; })[0];
      var last = arr[arr.length - 1];

      return "**" + nameOf(userId) + "** — " + arr.length + " جلسة، المجموع " + dur(totalOf(arr)) + "\n" +
        "• أكثر روم: " + top[0] + " (" + dur(top[1]) + ")\n" +
        "• آخر جلسة: " + ago(last.end) + " في " + last.where + " (" + dur(last.end - last.start) + ")";
    }
    var rows = Object.keys(data.voice)
      .map(function (id) { return { id: id, total: totalOf(data.voice[id]), n: data.voice[id].length }; })
      .sort(function (a, b) { return b.total - a.total; })
      .slice(0, 10)
      .map(function (r) { return "• **" + nameOf(r.id) + "**: " + dur(r.total) + " (" + r.n + " جلسة)"; });
    return rows.length ? "**أكثر ناس بالصوت:**\n" + rows.join("\n") : "ما سجلت جلسات صوتية بعد.";
  }

  function sectionAnniversary(userId) {
    if (userId) {
      var d = sinceOf(userId);
      if (!d) return nameOf(userId) + " مو في قائمة أصدقائك.";
      var days = Math.floor((Date.now() - d.getTime()) / 86400000);
      return "صرتم أصدقاء من **" + fmtDate(d.getTime()) + "** (" + days + " يوم)";
    }
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var rows = [];
    var ids = RelationshipStore.getFriendIDs();
    for (var i = 0; i < ids.length; i++) {
      var since = sinceOf(ids[i]);
      if (!since) continue;
      var next = new Date(now.getFullYear(), since.getMonth(), since.getDate());
      if (next.getTime() < todayStart) {
        next = new Date(now.getFullYear() + 1, since.getMonth(), since.getDate());
      }
      rows.push({ id: ids[i], next: next, years: next.getFullYear() - since.getFullYear() });
    }
    rows.sort(function (a, b) { return a.next.getTime() - b.next.getTime(); });
    var out = rows.slice(0, 5).map(function (r) {
      return "• **" + nameOf(r.id) + "**: " + fmtDate(r.next.getTime()) + " (" + r.years + " سنة)";
    });
    return out.length ? "**أقرب ذكريات الصداقة:**\n" + out.join("\n") : "ما لقيت أصدقاء.";
  }

  function sectionServers() {
    var guilds = Object.values(GuildStore.getGuilds());
    var rows = [];
    for (var i = 0; i < guilds.length; i++) {
      var g = guilds[i];
      var joined;
      try {
        var member = GuildMemberStore.getSelfMember(g.id);
        joined = member ? member.joinedAt : null;
      } catch (e) {
        joined = null;
      }
      var ts = joined ? new Date(joined).getTime() : NaN;
      if (!isNaN(ts)) rows.push({ name: g.name, ts: ts });
    }
    rows.sort(function (a, b) { return a.ts - b.ts; });
    if (!rows.length) return "ما قدرت أقرأ تواريخ الدخول.";
    var out = rows.slice(0, 10).map(function (r) {
      var days = Math.floor((Date.now() - r.ts) / 86400000);
      return "• **" + r.name + "**: " + fmtDate(r.ts) + " (" + days + " يوم)";
    });
    return "**أقدم سيرفراتك (من " + rows.length + "):**\n" + out.join("\n");
  }

  function sectionExposed() {
    var rows = data.exposed.slice(-15).reverse().map(function (e) {
      return "• " + ago(e.ts) + " **" + nameOf(e.userId) + "**: " + e.action + " (" + e.where + ")";
    });
    return rows.length
      ? "**اللي انكشفوا (أوفلاين وهم اونلاين):**\n" + rows.join("\n")
      : "ما انكشف أحد بعد.";
  }

  /* ───────────── أحداث Flux ───────────── */

  var handlers = {
    MESSAGE_CREATE: function (p) {
      if (p.optimistic) return;
      var m = p.message;
      var authorId = m && m.author ? m.author.id : undefined;
      activity(authorId, "أرسل رسالة", m ? m.channel_id : undefined);
    },

    TYPING_START: function (p) {
      activity(p.userId, "يكتب الآن", p.channelId);
    },

    VOICE_STATE_UPDATES: function (p) {
      var list = p.voiceStates || [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var id = s.userId;
        if (!isTracked(id)) continue;

        var cur = currentVoice.get(id);
        if (s.channelId) {
          if (cur && cur.channelId === s.channelId) continue; // تغيير ميوت/ديفن فقط
          if (cur) endVoice(id);
          currentVoice.set(id, {
            start: Date.now(),
            where: describeLocation(s.channelId),
            channelId: s.channelId
          });
          activity(id, "داخل روم صوتي", s.channelId);
        } else if (cur) {
          endVoice(id);
        }
      }
    },

    USER_UPDATE: function (p) {
      noteUser(p.user);
    },

    PRESENCE_UPDATES: function (p) {
      var list = p.updates || [];
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || !u.user) continue;
        noteUser(u.user);
        if (u.status && u.status !== "offline" && u.status !== "invisible" && isTracked(u.user.id)) {
          data.lastOnline[u.user.id] = Date.now();
          dirty = true;
        }
      }
    }
  };

  // نحمي كل معالج من الأخطاء عشان ما يخرب على ديسكورد
  var safeHandlers = {};
  Object.keys(handlers).forEach(function (evt) {
    safeHandlers[evt] = function (payload) {
      try {
        handlers[evt](payload);
      } catch (e) {
        console.error("[InvisibleDetector] " + evt, e);
      }
    };
  });

  /* ───────────── الأمر /invisible ───────────── */

  function choice(label, value) {
    return { name: label, displayName: label, value: value };
  }

  function registerInvisibleCommand() {
    unregisterCommand = registerCommand({
      name: "invisible",
      displayName: "invisible",
      description: "يعرض السجل التاريخي وحالة الاونلاين (آخر ظهور، اونلاين الحين، تغييرات، صوت، ذكريات، سيرفرات)",
      displayDescription: "يعرض السجل التاريخي وحالة الاونلاين (آخر ظهور، اونلاين الحين، تغييرات، صوت، ذكريات، سيرفرات)",
      applicationId: "-1",
      inputType: 1,
      type: 1,
      options: [
        {
          name: "section",
          displayName: "section",
          description: "القسم",
          displayDescription: "القسم",
          type: 3,
          required: true,
          choices: [
            choice("اونلاين الحين", "online"),
            choice("آخر ظهور", "lastseen"),
            choice("تاريخ التغييرات", "changes"),
            choice("سجل الصوت", "voice"),
            choice("ذكرى الصداقة", "anniversary"),
            choice("تواريخ السيرفرات", "servers"),
            choice("اللي انكشفوا", "exposed")
          ]
        },
        {
          name: "user",
          displayName: "user",
          description: "شخص معيّن (اختياري)",
          displayDescription: "شخص معيّن (اختياري)",
          type: 6,
          required: false
        }
      ],
      execute: function (args, ctx) {
        function get(name) {
          for (var i = 0; i < args.length; i++) {
            if (args[i].name === name) return args[i].value;
          }
          return "";
        }

        var section = get("section");
        var userId = get("user");
        var content;

        switch (section) {
          case "online": content = sectionOnline(userId); break;
          case "lastseen": content = sectionLastSeen(userId); break;
          case "changes": content = sectionChanges(userId); break;
          case "voice": content = sectionVoice(userId); break;
          case "anniversary": content = sectionAnniversary(userId); break;
          case "servers": content = sectionServers(); break;
          case "exposed": content = sectionExposed(); break;
          default: content = "اختر قسم من القائمة.";
        }

        // رسالة محلية (ما تنرسل لأحد)
        messageUtil.sendBotMessage(ctx.channel.id, content.slice(0, 1900));
      }
    });
  }

  /* ───────────── صفحة الإعدادات ───────────── */

  function Settings() {
    useProxy(storage);
    var s = cfg();

    function numberSetting(key, fallback) {
      return function (v) {
        var n = parseInt(v, 10);
        s[key] = isFinite(n) && n > 0 ? n : fallback;
      };
    }

    return React.createElement(
      ReactNative.ScrollView,
      null,
      React.createElement(Forms.FormSwitchRow, {
        label: "الأصدقاء فقط",
        subLabel: "موصى به، لأن حالة غير الأصدقاء ما تكون دايمًا معروفة وتعطي نتائج غلط",
        value: s.friendsOnly,
        onValueChange: function (v) { s.friendsOnly = v; }
      }),
      React.createElement(Forms.FormSwitchRow, {
        label: "إشعار ذكرى الصداقة السنوية",
        value: s.anniversaryNotify,
        onValueChange: function (v) { s.anniversaryNotify = v; }
      }),
      React.createElement(Forms.FormInput, {
        title: "أقل مدة (بالدقائق) بين تنبيهين لنفس الشخص",
        keyboardType: "numeric",
        value: String(s.cooldownMinutes),
        onChange: numberSetting("cooldownMinutes", 10)
      }),
      React.createElement(Forms.FormInput, {
        title: "كم دقيقة نعتبره 'مخفي' لو يظهر أوفلاين ونشاطه حديث",
        keyboardType: "numeric",
        value: String(s.hiddenWindowMinutes),
        onChange: numberSetting("hiddenWindowMinutes", 10)
      })
    );
  }

  /* ───────────── التشغيل والإيقاف ───────────── */

  function onLoad() {
    if (!storage.settings) storage.settings = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      if (storage.settings[k] === undefined) storage.settings[k] = DEFAULTS[k];
    });

    try {
      if (storage.data) {
        data = Object.assign(emptyData(), JSON.parse(JSON.stringify(storage.data)));
      }
    } catch (e) {
      console.error("[InvisibleDetector] load failed", e);
    }
    ready = true;

    // نسجّل حالة الأسماء والصور الحالية، ونكتشف أي تغيير صار وDiscord مقفل
    var ids = RelationshipStore.getFriendIDs();
    for (var i = 0; i < ids.length; i++) {
      var u = UserStore.getUser(ids[i]);
      if (u) {
        noteUser({ id: ids[i], username: u.username, globalName: u.globalName, avatar: u.avatar });
      }
      var st = PresenceStore.getStatus(ids[i]);
      if (st && st !== "offline" && isTracked(ids[i])) {
        data.lastOnline[ids[i]] = Date.now();
        dirty = true;
      }
    }

    Object.keys(safeHandlers).forEach(function (evt) {
      FluxDispatcher.subscribe(evt, safeHandlers[evt]);
    });

    registerInvisibleCommand();
    checkAnniversaries();
    flushTimer = setInterval(flush, 30000);
    annivTimer = setInterval(checkAnniversaries, 60 * 60000);
  }

  function onUnload() {
    Object.keys(safeHandlers).forEach(function (evt) {
      FluxDispatcher.unsubscribe(evt, safeHandlers[evt]);
    });
    if (unregisterCommand) unregisterCommand();
    clearInterval(flushTimer);
    clearInterval(annivTimer);
    Array.from(currentVoice.keys()).forEach(endVoice);
    flush();
    ready = false;
  }

  return {
    default: {
      onLoad: onLoad,
      onUnload: onUnload,
      settings: Settings
    }
  };
})();
