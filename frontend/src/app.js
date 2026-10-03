import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  page: "main",
  peaks: [],
  peaksError: "",
  peaksMsg: "",
  peaksLoading: false,
  selectedSpan: "",
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// 峰值墙数据一律来自服务端重算结果，前端只展示，绝不自行比较大小。
async function loadPeaks() {
  if (!state.token) return;
  state.peaksLoading = true;
  try {
    const list = await api("/api/peaks");
    state.peaks = list;
    state.peaksError = "";
    if (!list.some((p) => p.span_code === state.selectedSpan)) {
      state.selectedSpan = list.length ? list[0].span_code : "";
    }
  } catch {
    state.peaksError = "加载峰值墙失败，请重新登录";
  } finally {
    state.peaksLoading = false;
  }
  m.redraw();
}

async function lockSelectedSpan() {
  if (!state.selectedSpan) return;
  state.peaksError = "";
  state.peaksMsg = "";
  state.peaksLoading = true;
  try {
    // 只上送跨段编号；峰值与出现时刻由服务端按办结集合当场重算。
    const data = await api("/api/peaks/lock", {
      method: "POST",
      body: JSON.stringify({ span_code: state.selectedSpan }),
    });
    state.peaksMsg = data.message || "已锁定";
    await loadPeaks();
  } catch (err) {
    state.peaksError = err.message || "锁定失败";
  } finally {
    state.peaksLoading = false;
  }
  m.redraw();
}

function openPeakWall() {
  state.page = "peaks";
  state.peaksMsg = "";
  state.peaksError = "";
  loadPeaks();
}

function doLogout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.page = "main";
  state.peaks = [];
  state.selectedSpan = "";
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

function PeakWall() {
  const isWriter = state.user?.role === "writer";
  const selected =
    state.peaks.find((p) => p.span_code === state.selectedSpan) || null;
  return m("div.wrap", [
    m("div.topbar", [
      m("div", [
        m("h1", "历史峰值墙"),
        m(
          "p.sub",
          "各跨段办结读数的历史峰值与出现时刻；峰值由服务端按办结集合重算，锁定副本只读定格。"
        ),
      ]),
      m("div", [
        `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
        m(
          "button.secondary",
          {
            type: "button",
            onclick: () => {
              state.page = "main";
              m.redraw();
            },
          },
          "返回列表"
        ),
        " ",
        m(
          "button.secondary",
          { type: "button", onclick: doLogout },
          "退出"
        ),
      ]),
    ]),
    m("div.peakwall", [
      m("div.card.spanlist", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "跨段列表"),
        state.peaks.length
          ? m(
              "ul.spans",
              state.peaks.map((p) =>
                m(
                  "li",
                  {
                    key: p.span_code,
                    class: p.span_code === state.selectedSpan ? "active" : "",
                    onclick: () => {
                      state.selectedSpan = p.span_code;
                      m.redraw();
                    },
                  },
                  p.span_code
                )
              )
            )
          : m("p.sub", { style: { marginBottom: 0 } }, "暂无办结跨段"),
      ]),
      m("div.card.peakdetail", [
        m(
          "h2",
          { style: { marginTop: 0, fontSize: "1.1rem" } },
          selected ? `峰值 · ${selected.span_code}` : "峰值"
        ),
        selected
          ? m("div.peakcols", [
              m("div.peakcol", [
                m("h3", "当前峰值（未锁）"),
                m("div.peakval", `${selected.peak_microstrain} με`),
                m("div.peaktime", `出现时刻：${fmtTime(selected.peak_at)}`),
              ]),
              m("div.peakcol.locked", [
                m("h3", "锁定副本（只读）"),
                selected.locked
                  ? [
                      m(
                        "div.peakval",
                        `${selected.locked.peak_microstrain} με`
                      ),
                      m(
                        "div.peaktime",
                        `出现时刻：${fmtTime(selected.locked.peak_at)}`
                      ),
                      m(
                        "div.peaktime",
                        `由 ${selected.locked.locked_by} 锁于 ${fmtTime(
                          selected.locked.locked_at
                        )}`
                      ),
                    ]
                  : m("div.peaktime", "未锁定"),
              ]),
            ])
          : m("p.sub", { style: { marginBottom: 0 } }, "请选择左侧跨段"),
      ]),
    ]),
    m("div.card.peakactions", [
      m("div.row", [
        m(
          "button",
          {
            type: "button",
            disabled: state.peaksLoading,
            onclick: loadPeaks,
          },
          "刷新"
        ),
        isWriter
          ? m(
              "button",
              {
                type: "button",
                disabled:
                  state.peaksLoading || !selected || Boolean(selected.locked),
                onclick: lockSelectedSpan,
              },
              selected && selected.locked ? "已锁定" : "锁定当前跨段峰值"
            )
          : m("span.hint", "复核岗只读，不能锁定峰值"),
      ]),
      state.peaksError ? m("p.err", state.peaksError) : null,
      state.peaksMsg ? m("p.ok", state.peaksMsg) : null,
    ]),
  ]);
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(state.loginForm),
                    });
                    state.token = data.access_token;
                    state.user = { username: data.username, role: data.role };
                    localStorage.setItem(TOKEN_KEY, state.token);
                    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
                    await loadReadings();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "用户名",
                    m("input", {
                      value: state.loginForm.username,
                      oninput: (e) => {
                        state.loginForm.username = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "密码",
                    m("input", {
                      type: "password",
                      value: state.loginForm.password,
                      oninput: (e) => {
                        state.loginForm.password = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    if (state.page === "peaks") {
      return PeakWall();
    }

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          m(
            "button.secondary",
            { type: "button", onclick: openPeakWall },
            "峰值墙"
          ),
          " ",
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            { type: "button", onclick: doLogout },
            "退出"
          ),
        ]),
      ]),
      isWriter
        ? m("div.card", [
            m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.msg = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/readings", {
                      method: "POST",
                      body: JSON.stringify({
                        span_code: state.submitForm.span_code,
                        microstrain: parseFloat(state.submitForm.microstrain),
                      }),
                    });
                    state.msg = data.message || "已提交";
                    state.submitForm = { span_code: "", microstrain: "" };
                    await loadReadings();
                  } catch (err) {
                    state.error = err.message || "提交失败";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "跨段编号",
                    m("input", {
                      required: true,
                      placeholder: "例如 跨中S3",
                      value: state.submitForm.span_code,
                      oninput: (e) => {
                        state.submitForm.span_code = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "微应变（με）",
                    m("input", {
                      required: true,
                      type: "number",
                      step: "0.1",
                      value: state.submitForm.microstrain,
                      oninput: (e) => {
                        state.submitForm.microstrain = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "提交"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
                state.msg ? m("p.ok", state.msg) : null,
              ]
            ),
          ])
        : null,
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "编号"),
              m("th", "跨段"),
              m("th", "微应变"),
              m("th", "结论"),
              m("th", "说明"),
              m("th", "状态"),
              m("th", "提交人"),
            ]),
          ]),
          m(
            "tbody",
            state.rows.length
              ? state.rows.map((r) =>
                  m("tr", { key: r.id }, [
                    m("td", r.id),
                    m("td", r.span_code),
                    m("td", r.microstrain),
                    m("td", [
                      m(
                        "span",
                        { class: verdictClass(r.verdict, r.status) },
                        displayVerdict(r)
                      ),
                    ]),
                    m("td", r.reason || "—"),
                    m("td", r.status),
                    m("td", r.created_by),
                  ])
                )
              : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
          ),
        ]),
      ]),
    ]);
  },
};

export default App;
