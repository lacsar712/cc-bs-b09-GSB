// 登录态：令牌与当前用户，持久化到 localStorage，供主页与峰值墙共用。
const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export const auth = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: readUser(),

  save(data) {
    this.token = data.access_token;
    this.user = { username: data.username, role: data.role };
    localStorage.setItem(TOKEN_KEY, this.token);
    localStorage.setItem(USER_KEY, JSON.stringify(this.user));
  },

  clear() {
    this.token = "";
    this.user = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },

  isWriter() {
    return this.user?.role === "writer";
  },
};
