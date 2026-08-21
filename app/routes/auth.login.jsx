import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../shopify.server";

export const loader = async ({ request }) => {
  const errors = await login(request);
  return errors;
};

export const action = async ({ request }) => {
  const errors = await login(request);
  return errors;
};

export default function AuthLogin() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const errors = actionData?.errors || loaderData?.errors;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 480 }}>
      <h1>Install store app</h1>
      <p>Enter the live shop domain (<code>*.myshopify.com</code>) to install / authorize this app.</p>
      <Form method="post">
        <label htmlFor="shop" style={{ display: "block", marginBottom: 8 }}>
          Shop domain
        </label>
        <input
          id="shop"
          name="shop"
          type="text"
          defaultValue="pureairflow.myshopify.com"
          placeholder="pureairflow.myshopify.com"
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />
        {errors?.shop ? (
          <p style={{ color: "crimson" }}>{errors.shop}</p>
        ) : null}
        <button type="submit" style={{ padding: "8px 16px" }}>
          Log in
        </button>
      </Form>
    </div>
  );
}
