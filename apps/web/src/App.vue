<script setup lang="ts">
import { reactive, ref } from "vue";
import type { Agent, AgentInput, ApiErrorBody, FieldIssue } from "./agent";

// Human-readable labels for API field names, so "is required" reads as
// "First name is required" instead of a JSON-shaped fragment. This is
// display formatting, not a second copy of the validation rules - the API
// still decides what's wrong, the form just decides how it reads.
const FIELD_LABELS: Record<keyof AgentInput, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  mobileNumber: "Mobile number",
};

// Upsert: blank id -> POST (create), filled id -> PUT (update). Per the
// brief, list/get/delete are curl-only (see apps/api/README.md) - this form
// only creates and updates, so it needs the target id typed in by hand for
// an update rather than a picker sourced from a list endpoint the UI never calls.
const id = ref("");
const form = reactive<AgentInput>({
  firstName: "",
  lastName: "",
  email: "",
  mobileNumber: "",
});

// isSubmitting gates the button and guards against a second request firing
// mid-flight; status only picks which message to render. Keeping them
// separate matters because resetMessages() runs on every keystroke in the
// id field - if it also touched isSubmitting, editing the id while a
// request was in flight would re-enable the button, let a second request
// start, and whichever response lands second would silently overwrite the
// first one's result.
type Status = "idle" | "success" | "error";
const status = ref<Status>("idle");
const isSubmitting = ref(false);
const fieldErrors = ref<Partial<Record<keyof AgentInput, string>>>({});
const formError = ref("");
const savedAgent = ref<Agent | null>(null);

function resetMessages() {
  status.value = "idle";
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;
}

async function submit() {
  if (isSubmitting.value) return;
  isSubmitting.value = true;
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;

  const isUpdate = id.value.trim().length > 0;
  const url = isUpdate ? `/agents/${id.value.trim()}` : "/agents";
  const method = isUpdate ? "PUT" : "POST";

  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });

    if (res.ok) {
      savedAgent.value = (await res.json()) as Agent;
      status.value = "success";
      return;
    }

    status.value = "error";

    // Server owns validation (mirrors docs/schema.sql). The form renders
    // whatever it says rather than re-deciding what's valid client-side -
    // see apps/api/README.md "Error handling" for the response shape.
    //
    // A failed/malformed body means this response didn't come from the API
    // at all - it's the dev proxy (or any reverse proxy) reporting it
    // couldn't reach the server, which Vite's proxy surfaces as a bare 500
    // with an empty text/plain body, not a JSON {error} the API would send.
    // The status code alone can't distinguish "the API returned 500" from
    // "nothing answered", but the body shape can.
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (typeof body?.error !== "string") {
      formError.value = "could not reach the server";
      return;
    }
    if (body.issues) {
      fieldErrors.value = Object.fromEntries(
        body.issues.map((issue: FieldIssue) => [issue.field, `${FIELD_LABELS[issue.field]} ${issue.message}`]),
      );
    }
    formError.value = body.error;
  } catch {
    status.value = "error";
    formError.value = "could not reach the server";
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <main>
    <h1>Property Agent</h1>
    <p class="hint">
      Create a new agent, or fill in an existing <code>id</code> to update one.
      Listing, viewing, and deleting are curl-only - see
      <code>apps/api/README.md</code>.
    </p>

    <form @submit.prevent="submit">
      <label for="agent-id">
        Agent id <span class="optional">(leave blank to create)</span>
        <input id="agent-id" v-model.trim="id" type="text" placeholder="existing agent id" @input="resetMessages" />
      </label>

      <label for="first-name">
        First name
        <input
          id="first-name"
          v-model.trim="form.firstName"
          type="text"
          required
          :aria-invalid="!!fieldErrors.firstName"
          :aria-describedby="fieldErrors.firstName ? 'first-name-error' : undefined"
        />
        <span id="first-name-error" class="field-error" role="alert">{{ fieldErrors.firstName }}</span>
      </label>

      <label for="last-name">
        Last name
        <input
          id="last-name"
          v-model.trim="form.lastName"
          type="text"
          required
          :aria-invalid="!!fieldErrors.lastName"
          :aria-describedby="fieldErrors.lastName ? 'last-name-error' : undefined"
        />
        <span id="last-name-error" class="field-error" role="alert">{{ fieldErrors.lastName }}</span>
      </label>

      <label for="email">
        Email
        <input
          id="email"
          v-model.trim="form.email"
          type="email"
          required
          :aria-invalid="!!fieldErrors.email"
          :aria-describedby="fieldErrors.email ? 'email-error' : undefined"
        />
        <span id="email-error" class="field-error" role="alert">{{ fieldErrors.email }}</span>
      </label>

      <label for="mobile-number">
        Mobile number <span class="optional">(E.164, e.g. +61412345678)</span>
        <input
          id="mobile-number"
          v-model.trim="form.mobileNumber"
          type="tel"
          required
          :aria-invalid="!!fieldErrors.mobileNumber"
          :aria-describedby="fieldErrors.mobileNumber ? 'mobile-number-error' : undefined"
        />
        <span id="mobile-number-error" class="field-error" role="alert">{{ fieldErrors.mobileNumber }}</span>
      </label>

      <button type="submit" :disabled="isSubmitting">
        {{ id ? "Update agent" : "Create agent" }}
      </button>
    </form>

    <p v-if="status === 'error' && formError" class="form-error" role="alert">{{ formError }}</p>

    <div v-if="status === 'success' && savedAgent" class="success" role="status">
      <p>Saved.</p>
      <pre>{{ JSON.stringify(savedAgent, null, 2) }}</pre>
    </div>
  </main>
</template>

<style scoped>
main {
  max-width: 32rem;
  margin: 2rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
}

.hint {
  color: #555;
  font-size: 0.9rem;
}

form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-weight: 600;
  font-size: 0.9rem;
}

.optional {
  font-weight: 400;
  color: #777;
}

input {
  font: inherit;
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}

button {
  align-self: flex-start;
  padding: 0.5rem 1.25rem;
  font: inherit;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.field-error {
  display: block;
  min-height: 1.1rem;
  color: #b00020;
  font-weight: 400;
  font-size: 0.85rem;
}

.form-error {
  color: #b00020;
  margin-top: 1rem;
}

.success {
  margin-top: 1.5rem;
}

.success pre {
  background: #f5f5f5;
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
}
</style>
