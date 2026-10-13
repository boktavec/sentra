import { apiGet } from "./api.ts";
import { callApi } from "./auth.ts";

/** The signed-in user's ID, for "(you)" and "You" markers. */
export const fetchMe = () => callApi((token) => apiGet<{ id: string }>("/v1/me", token));
