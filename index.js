import { registerCommand } from "@vendetta/commands";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

/* ───────────── المتاجر (Stores) ───────────── */

const UserStore: any = findByStoreName("UserStore");
const ChannelStore: any = findByStoreName("ChannelStore");
const GuildStore: any = findByStoreName("GuildStore");
const GuildMemberStore: any = findByStoreName("GuildMemberStore");
const PresenceStore: any = findByStoreName("PresenceStore");
const RelationshipStore: any = findByStoreName("RelationshipStore");
const messageUtil: any = findByProps("sendBotMessage");

/* ───────────── الإعدادات ───────────── */

const defaultSettings = {
    friendsOnly: true,
    cooldownMinutes: 10,
    anniversaryNotify: true
};

const cfg = () => storage.settings as typeof defaultSettings;

/* ───────────── البيانات ───────────── */

const MAX_PER_USER = 60;

interface Data {
    lastSeen: Record<string, { ts: number; action: string; where: string }>;
    profiles: Record<string, { username?: string; globalName?: string | null; avatar?: string | null }>;
    changes: Record<string, { ts: number; text: string }[]>;
    voice: Record<string, { start: number; end: number; where: string }[]>;
    exposed: { ts: number; userId: string; action: string; where: string }[];
    lastAnniversaryCheck: string;
}

const emptyData = (): Data => ({
    lastSeen: {}, profiles: {}, changes: {}, voice: {}, exposed: [], lastAnniversaryCheck: ""
});

let data: Data = emptyData();
let ready = false;
let dirty = false;
let flushTimer: any;
let annivTimer: any;

const currentVoice = new Map<string, { start: number; where: string; channelId: string }>();
const lastAlert = new Map<string, number>();

function flush() {
    if (!dirty || !ready) return;
    dirty = false;
    try {
        // نعطي مرجع جديد عشان يتحفظ في التخزين
        storage.data = { ...data };
    } catch (e) {
        dirty = true;
        console.error("[InvisibleDetector] save failed", e);
    }
}

/* ───────────── أدوات مساعدة ───────────── */

const nameOf = (id: string) => {
    const u: any = UserStore.getUser(id);
    return u?.globalName ?? u?.username ?? id;
};

const fmtDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function ago(ts: number) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "الحين";
    if (m < 60) return `قبل ${m} دقيقة`;
    const h = Math.floor(m / 60);
    if (h < 24) return `قبل ${h} ساعة`;
    return `قبل ${Math.floor(h / 24)} يوم`;
}

function dur(ms: number) {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} دقيقة` : `${(m / 60).toFixed(1)} ساعة`;
}

function describeLocation(channelId?: string): string {
    if (!channelId) return "مكان غير معروف";
    const channel: any = ChannelStore.getChannel(channelId);
    if (!channel) return "مكان غير معروف";

    if (!channel.guild_id) {
        return channel.type === 3 ? "مجموعة خاصة" : "رسائل خاصة (DM)";
    }

    const guild: any = GuildStore.getGuild(channel.guild_id);
    const isVoice = channel.type === 2 || channel.type === 13;
    const name = isVoice ? `🔊 ${channel.name}` : `#${channel.name}`;
    return `${guild?.name ?? "سيرفر"} › ${name}`;
}

function isTracked(userId?: string): boolean {
    if (!userId || !ready) return false;
    const me = UserStore.getCurrentUser();
    if (!me || userId === me.id) return false;
    if (cfg().friendsOnly && !RelationshipStore.isFriend(userId)) return false;
    const u: any = UserStore.getUser(userId);
    if (u?.bot) return false;
    return true;
}

/* ───────────── تسجيل النشاط وكشف الأوفلاين ───────────── */

function activity(userId: string | undefined, action: string, channelId?: string) {
    if (!userId || !isTracked(userId)) return;

    const where = describeLocation(channelId);
    data.lastSeen[userId] = { ts: Date.now(), action, where };
    dirty = true;

    // حالته الظاهرة لك "أوفلاين" لكنه سوّا نشاط فعلي
    if (PresenceStore.getStatus(userId) !== "offline") return;

    const now = Date.now();
    const cooldown = Math.max(1, Number(cfg().cooldownMinutes) || 10) * 60_000;
    if (now - (lastAlert.get(userId) ?? 0) < cooldown) return;
    lastAlert.set(userId, now);

    data.exposed.push({ ts: now, userId, action, where });
    if (data.exposed.length > 100) data.exposed.splice(0, data.exposed.length - 100);

    showToast(`${nameOf(userId)} حالته أوفلاين وهو اونلاين\n${action} — ${where}`);
}

/* ───────────── تاريخ التغييرات ───────────── */

function logChange(userId: string, text: string) {
    const arr = (data.changes[userId] ??= []);
    arr.push({ ts: Date.now(), text });
    if (arr.length > MAX_PER_USER) arr.splice(0, arr.length - MAX_PER_USER);
    dirty = true;
}

function noteUser(u: any) {
    if (!u?.id || !isTracked(u.id)) return;

    const prev = data.profiles[u.id];
    const globalName = u.global_name !== undefined ? u.global_name
        : u.globalName !== undefined ? u.globalName
            : prev?.globalName;

    const next = {
        username: u.username ?? prev?.username,
        globalName,
        avatar: u.avatar !== undefined ? u.avatar : prev?.avatar
    };

    if (prev) {
        if (prev.username !== undefined && prev.username !== next.username)
            logChange(u.id, `غيّر اسم المستخدم: ${prev.username} ← ${next.username}`);
        if (prev.globalName !== undefined && prev.globalName !== next.globalName)
            logChange(u.id, `غيّر الاسم المعروض: ${prev.globalName ?? "(بدون)"} ← ${next.globalName ?? "(بدون)"}`);
        if (prev.avatar !== undefined && prev.avatar !== next.avatar)
            logChange(u.id, "غيّر صورته الشخصية");
    }

    data.profiles[u.id] = next;
    dirty = true;
}

/* ───────────── الرومات الصوتية ───────────── */

function endVoice(userId: string) {
    const cur = currentVoice.get(userId);
    if (!cur) return;
    currentVoice.delete(userId);

    const arr = (data.voice[userId] ??= []);
    arr.push({ start: cur.start, end: Date.now(), where: cur.where });
    if (arr.length > MAX_PER_USER) arr.splice(0, arr.length - MAX_PER_USER);
    dirty = true;
}

/* ───────────── ذكرى الصداقة ───────────── */

const sinceOf = (id: string): Date | null => {
    const s = RelationshipStore.getSince?.(id);
    return s ? new Date(s) : null;
};

function checkAnniversaries() {
    if (!ready || !cfg().anniversaryNotify) return;

    const today = new Date();
    const key = today.toDateString();
    if (data.lastAnniversaryCheck === key) return;
    data.lastAnniversaryCheck = key;
    dirty = true;

    for (const id of RelationshipStore.getFriendIDs()) {
        const d = sinceOf(id);
        if (!d) continue;
        const years = today.getFullYear() - d.getFullYear();
        if (years >= 1 && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
            showToast(`🎉 اليوم صار لك ${years} ${years === 1 ? "سنة" : "سنوات"} مع ${nameOf(id)}`);
        }
    }
}

/* ───────────── أقسام أمر /invisible ───────────── */

function sectionLastSeen(userId: string) {
    if (userId) {
        const e = data.lastSeen[userId];
        return e
            ? `**${nameOf(userId)}** آخر نشاط ${ago(e.ts)} (${e.action}) في ${e.where}`
            : `**${nameOf(userId)}**: ما سجلت له نشاط بعد.`;
    }
    const rows = Object.entries(data.lastSeen)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, 15)
        .map(([id, e]) => `• **${nameOf(id)}**: ${ago(e.ts)} — ${e.action} (${e.where})`);
    return rows.length ? `**آخر ظهور:**\n${rows.join("\n")}` : "ما فيه سجل بعد.";
}

function sectionChanges(userId: string) {
    if (userId) {
        const arr = (data.changes[userId] ?? []).slice(-15).reverse();
        return arr.length
            ? `**تغييرات ${nameOf(userId)}:**\n${arr.map(c => `• ${fmtDate(c.ts)}: ${c.text}`).join("\n")}`
            : `ما سجلت أي تغيير لـ ${nameOf(userId)}.`;
    }
    const all = Object.entries(data.changes)
        .flatMap(([id, arr]) => arr.map(c => ({ id, ...c })))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 15)
        .map(c => `• ${fmtDate(c.ts)} **${nameOf(c.id)}**: ${c.text}`);
    return all.length ? `**آخر التغييرات:**\n${all.join("\n")}` : "ما سجلت أي تغيير بعد.";
}

function sectionVoice(userId: string) {
    if (userId) {
        const arr = data.voice[userId] ?? [];
        if (!arr.length) return `ما سجلت جلسات صوتية لـ ${nameOf(userId)}.`;
        const total = arr.reduce((s, x) => s + (x.end - x.start), 0);
        const byPlace = new Map<string, number>();
        for (const x of arr) byPlace.set(x.where, (byPlace.get(x.where) ?? 0) + (x.end - x.start));
        const top = [...byPlace.entries()].sort((a, b) => b[1] - a[1])[0];
        const last = arr[arr.length - 1];
        return `**${nameOf(userId)}** — ${arr.length} جلسة، المجموع ${dur(total)}\n` +
            `• أكثر روم: ${top[0]} (${dur(top[1])})\n` +
            `• آخر جلسة: ${ago(last.end)} في ${last.where} (${dur(last.end - last.start)})`;
    }
    const rows = Object.entries(data.voice)
        .map(([id, arr]) => [id, arr.reduce((s, x) => s + (x.end - x.start), 0), arr.length] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, total, n]) => `• **${nameOf(id)}**: ${dur(total)} (${n} جلسة)`);
    return rows.length ? `**أكثر ناس بالصوت:**\n${rows.join("\n")}` : "ما سجلت جلسات صوتية بعد.";
}

function sectionAnniversary(userId: string) {
    if (userId) {
        const d = sinceOf(userId);
        if (!d) return `${nameOf(userId)} مو في قائمة أصدقائك.`;
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        return `صرتم أصدقاء من **${fmtDate(d.getTime())}** (${days} يوم)`;
    }
    const now = new Date();
    const rows: { id: string; next: Date; years: number }[] = [];
    for (const id of RelationshipStore.getFriendIDs()) {
        const d = sinceOf(id);
        if (!d) continue;
        let next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
        if (next.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime())
            next = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate());
        rows.push({ id, next, years: next.getFullYear() - d.getFullYear() });
    }
    rows.sort((a, b) => a.next.getTime() - b.next.getTime());
    const out = rows.slice(0, 5).map(r => `• **${nameOf(r.id)}**: ${fmtDate(r.next.getTime())} (${r.years} سنة)`);
    return out.length ? `**أقرب ذكريات الصداقة:**\n${out.join("\n")}` : "ما لقيت أصدقاء.";
}

function sectionServers() {
    const rows = Object.values(GuildStore.getGuilds() as Record<string, any>)
        .map(g => {
            let j: any;
            try { j = GuildMemberStore.getSelfMember(g.id)?.joinedAt; } catch { /* ignore */ }
            return { name: g.name as string, ts: j ? new Date(j).getTime() : NaN };
        })
        .filter(x => !Number.isNaN(x.ts))
        .sort((a, b) => a.ts - b.ts);
    if (!rows.length) return "ما قدرت أقرأ تواريخ الدخول.";
    const out = rows.slice(0, 10).map(r => {
        const days = Math.floor((Date.now() - r.ts) / 86400000);
        return `• **${r.name}**: ${fmtDate(r.ts)} (${days} يوم)`;
    });
    return `**أقدم سيرفراتك (من ${rows.length}):**\n${out.join("\n")}`;
}

function sectionExposed() {
    const rows = data.exposed.slice(-15).reverse()
        .map(e => `• ${ago(e.ts)} **${nameOf(e.userId)}**: ${e.action} (${e.where})`);
    return rows.length ? `**اللي انكشفوا (أوفلاين وهم اونلاين):**\n${rows.join("\n")}` : "ما انكشف أحد بعد.";
}

/* ───────────── Flux ───────────── */

const handlers: Record<string, (payload: any) => void> = {
    MESSAGE_CREATE({ message, optimistic }) {
        if (optimistic) return;
        activity(message?.author?.id, "أرسل رسالة", message?.channel_id);
    },
    TYPING_START({ userId, channelId }) {
        activity(userId, "يكتب الآن", channelId);
    },
    VOICE_STATE_UPDATES({ voiceStates }) {
        for (const s of voiceStates ?? []) {
            const id = s.userId;
            if (!isTracked(id)) continue;

            const cur = currentVoice.get(id);
            if (s.channelId) {
                if (cur?.channelId === s.channelId) continue; // تغيير ميوت/ديفن فقط
                if (cur) endVoice(id);
                currentVoice.set(id, { start: Date.now(), where: describeLocation(s.channelId), channelId: s.channelId });
                activity(id, "داخل روم صوتي", s.channelId);
            } else if (cur) {
                endVoice(id);
            }
        }
    },
    USER_UPDATE({ user }) {
        noteUser(user);
    },
    PRESENCE_UPDATES({ updates }) {
        for (const u of updates ?? []) noteUser(u?.user);
    }
};

// نحمي كل معالج من الأخطاء عشان ما يخرب على ديسكورد
const safeHandlers: typeof handlers = {};
for (const [evt, fn] of Object.entries(handlers)) {
    safeHandlers[evt] = payload => {
        try { fn(payload); } catch (e) { console.error(`[InvisibleDetector] ${evt}`, e); }
    };
}

/* ───────────── الأمر ───────────── */

const choice = (label: string, value: string) => ({ name: label, displayName: label, value });

let unregisterCommand: (() => void) | undefined;

function registerInvisibleCommand() {
    unregisterCommand = registerCommand({
        name: "invisible",
        displayName: "invisible",
        description: "يعرض السجل التاريخي (آخر ظهور، تغييرات، صوت، ذكريات، سيرفرات)",
        displayDescription: "يعرض السجل التاريخي (آخر ظهور، تغييرات، صوت، ذكريات، سيرفرات)",
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
        execute(args: any[], ctx: any) {
            const get = (n: string) => args.find(a => a.name === n)?.value ?? "";
            const section = get("section");
            const userId = get("user");

            let content: string;
            switch (section) {
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
    } as any);
}

/* ───────────── صفحة الإعدادات ───────────── */

function Settings() {
    useProxy(storage);
    const s = cfg();
    const F: any = Forms;

    return React.createElement(
        ReactNative.ScrollView,
        null,
        React.createElement(F.FormSwitchRow, {
            label: "الأصدقاء فقط",
            subLabel: "موصى به، لأن حالة غير الأصدقاء ما تكون دايمًا معروفة وتعطي نتائج غلط",
            value: s.friendsOnly,
            onValueChange: (v: boolean) => { s.friendsOnly = v; }
        }),
        React.createElement(F.FormSwitchRow, {
            label: "إشعار ذكرى الصداقة السنوية",
            value: s.anniversaryNotify,
            onValueChange: (v: boolean) => { s.anniversaryNotify = v; }
        }),
        React.createElement(F.FormInput, {
            title: "أقل مدة (بالدقائق) بين تنبيهين لنفس الشخص",
            keyboardType: "numeric",
            value: String(s.cooldownMinutes),
            onChange: (v: string) => {
                const n = parseInt(v, 10);
                s.cooldownMinutes = Number.isFinite(n) && n > 0 ? n : 10;
            }
        })
    );
}

/* ───────────── البلوقن ───────────── */

export default {
    onLoad() {
        storage.settings ??= {};
        for (const [k, v] of Object.entries(defaultSettings)) {
            if (storage.settings[k] === undefined) storage.settings[k] = v;
        }

        try {
            if (storage.data) data = { ...emptyData(), ...JSON.parse(JSON.stringify(storage.data)) };
        } catch (e) {
            console.error("[InvisibleDetector] load failed", e);
        }
        ready = true;

        // نسجّل حالة الأسماء والصور الحالية، ونكتشف أي تغيير صار وDiscord مقفل
        for (const id of RelationshipStore.getFriendIDs()) {
            const u: any = UserStore.getUser(id);
            if (u) noteUser({ id, username: u.username, globalName: u.globalName, avatar: u.avatar });
        }

        for (const [evt, fn] of Object.entries(safeHandlers)) FluxDispatcher.subscribe(evt, fn);

        registerInvisibleCommand();
        checkAnniversaries();
        flushTimer = setInterval(flush, 30_000);
        annivTimer = setInterval(checkAnniversaries, 60 * 60_000);
    },

    onUnload() {
        for (const [evt, fn] of Object.entries(safeHandlers)) FluxDispatcher.unsubscribe(evt, fn);
        unregisterCommand?.();
        clearInterval(flushTimer);
        clearInterval(annivTimer);
        for (const id of [...currentVoice.keys()]) endVoice(id);
        flush();
        ready = false;
    },

    settings: Settings
};
