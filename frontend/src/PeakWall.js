import m from "mithril";
import { api } from "./http.js";
import { auth } from "./auth.js";

// 历史峰值墙专页。
//
// 铁律：本页的峰值与出现时刻一律来自 GET /api/peak-wall，由后台对
// status='done' 的办结集合重算。前端不读取 readings 明细、不做 Math.max
// 之类的任何比较——专页私改峰值而绕过后台重算，等于整题失败。
//
// 每个跨段后端返回：
//   peak_microstrain / peak_at  —— 未锁栏：后台实时重算结果，无办结为 null
//   locked / lock{...}          —— 锁区：锁定瞬间抄下的只读副本，此后定格
const state = {
  items: [],
  selected: "",
  loading: false,
  locking: false,
  error: "",
  timer: null,
};

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function loadWall() {
  if (!auth.token) return;
  try {
    const items = await api("/api/peak-wall");
    state.items = items;
    // 列表刷新后保持选中仍存在；否则落到第一项
    if (!items.some((it) => it.span_code === state.selected)) {
      state.selected = items.length ? items[0].span_code : "";
    }
    state.error = "";
  } catch {
    state.error = "加载峰值墙失败，请重新登录";
  }
  m.redraw();
}

async function lockCurrent() {
  const item = state.items.find((it) => it.span_code === state.selected);
  if (!item || item.locked) return;
  state.locking = true;
  state.error = "";
  try {
    // 只把跨段编号交给后台；峰值/时刻由后台重算后自行抄入锁区，
    // 前端不传、也无法伪造锁区数字。
    await api("/api/peak-wall/locks", {
      method: "POST",
      body: JSON.stringify({ span_code: item.span_code }),
    });
    await loadWall();
  } catch (err) {
    state.error = err.message || "锁定失败";
  } finally {
    state.locking = false;
    m.redraw();
  }
}

const PeakWall = {
  oninit() {
    loadWall();
    // 下挂自动刷新：轮询后台重算结果
    state.timer = setInterval(loadWall, 3000);
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },

  view() {
    const item = state.items.find((it) => it.span_code === state.selected) || null;
    const canLock = auth.isWriter();
    const hasPeak = !!item && item.peak_microstrain !== null;

    return m("div.card.wall", [
      m("div.wall-head", [
        m("h2", { style: { margin: 0, fontSize: "1.1rem" } }, "历史峰值墙"),
        m(
          "button.secondary.small",
          {
            type: "button",
            disabled: state.loading,
            onclick: () => {
              state.loading = true;
              loadWall().finally(() => {
                state.loading = false;
                m.redraw();
              });
            },
          },
          "刷新"
        ),
      ]),
      m(
        "p.sub",
        { style: { margin: "0.5rem 0 0" } },
        "峰值由后台按已办结集合重算，无办结的跨段不显示峰值；锁定后锁区数字定格，新办结只改未锁栏。"
      ),
      state.error ? m("p.err", state.error) : null,

      m("div.wall-body", [
        // 左：跨段列表
        m("div.wall-list", [
          m("div.wall-col-title", "跨段"),
          state.items.length
            ? state.items.map((it) =>
                m(
                  "button.wall-item" +
                    (it.span_code === state.selected ? ".active" : ""),
                  {
                    key: it.span_code,
                    type: "button",
                    onclick: () => {
                      state.selected = it.span_code;
                    },
                  },
                  [
                    m("span.wall-item-name", it.span_code),
                    it.locked ? m("span.lock-flag", "已锁") : null,
                  ]
                )
              )
            : m("div.wall-empty", "暂无跨段"),
        ]),

        // 右：峰值与出现时刻 + 锁区只读副本
        m("div.wall-detail", [
          item
            ? [
                m("div.wall-col-title", item.span_code),

                // 未锁栏：后台实时重算
                m("div.peak-box", [
                  m("div.peak-box-label", "当前峰值（后台重算 · 未锁栏）"),
                  hasPeak
                    ? [
                        m("div.peak-value", `${item.peak_microstrain} με`),
                        m(
                          "div.peak-time",
                          `出现时刻：${formatTime(item.peak_at)}`
                        ),
                      ]
                    : [
                        // 无办结集合：绝不写出任何峰值数字
                        m("div.peak-value.empty", "—"),
                        m("div.peak-time", "尚无办结读数，无峰值"),
                      ],
                ]),

                // 锁区：只读副本，锁定瞬间抄入，此后定格
                m("div.peak-box.locked-box", [
                  m("div.peak-box-label", "锁区（只读副本 · 定格）"),
                  item.lock
                    ? [
                        m(
                          "div.peak-value",
                          `${item.lock.peak_microstrain} με`
                        ),
                        m(
                          "div.peak-time",
                          `出现时刻：${formatTime(item.lock.peak_at)}`
                        ),
                        m(
                          "div.peak-time",
                          `锁定人：${item.lock.locked_by}　锁定于：${formatTime(
                            item.lock.locked_at
                          )}`
                        ),
                      ]
                    : [
                        m("div.peak-value.empty", "未锁定"),
                        m("div.peak-time", "锁定后此处抄入当时峰值并永久定格"),
                      ],
                ]),

                canLock
                  ? m(
                      "button",
                      {
                        type: "button",
                        disabled:
                          state.locking || item.locked || !hasPeak,
                        title: item.locked
                          ? "锁区已定格"
                          : !hasPeak
                            ? "无办结读数，不能锁定"
                            : "",
                        onclick: lockCurrent,
                      },
                      item.locked ? "已锁定（定格）" : "锁定当前峰值"
                    )
                  : m("p.sub", { style: { margin: "0.5rem 0 0" } },
                      "复核岗只读，不能锁定"),
              ]
            : m("div.wall-empty", "请选择左侧跨段"),
        ]),
      ]),
    ]);
  },
};

export default PeakWall;
