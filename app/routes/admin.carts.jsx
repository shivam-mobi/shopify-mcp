import { redirect } from "react-router";

export const loader = async () => {
  return redirect("/admin/customers");
};

export default function AdminCartsRedirect() {
  return null;
}
