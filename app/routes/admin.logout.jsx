import { logoutAdmin } from "../admin/auth.server";

export const action = async ({ request }) => {
  return logoutAdmin(request);
};

export const loader = async ({ request }) => {
  return logoutAdmin(request);
};
