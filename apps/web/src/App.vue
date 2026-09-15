<script setup lang="ts">
import { reactive, ref } from "vue";
import type { Agent, AgentInput, ApiErrorBody, FieldIssue } from "./agent";

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

type Status = "idle" | "submitting" | "success" | "error";
const status = ref<Status>("idle");
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
  status.value = "submitting";
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

    // Server owns validation (mirrors docs/schema.sql). The form renders
    // whatever it says rather than re-deciding what's valid client-side -
    // see apps/api/README.md "Error handling" for the response shape.
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    status.value = "error";
    if (body?.issues) {
      fieldErrors.value = Object.fromEntries(
        body.issues.map((issue: FieldIssue) => [issue.field, issue.message]),
      );
    }
    formError.value = body?.error ?? `request failed with status ${res.status}`;
  } catch {
    status.value = "error";
    formError.value = "could not reach the server";
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

    <form @submit.prevent="submit" novalidate>
      <label>
        Agent id <span class="optional">(leave blank to create)</span>
        <input v-model.trim="id" type="text" placeholder="existing agent id" @input="resetMessages" />
      </label>

      <label>
        First name
        <input v-model.trim="form.firstName" type="text" required />
        <span v-if="fieldErrors.firstName" class="field-error">{{ fieldErrors.firstName }}</span>
      </label>

      <label>
        Last name
        <input v-model.trim="form.lastName" type="text" required />
        <span v-if="fieldErrors.lastName" class="field-error">{{ fieldErrors.lastName }}</span>
      </label>

      <label>
        Email
        <input v-model.trim="form.email" type="email" required />
        <span v-if="fieldErrors.email" class="field-error">{{ fieldErrors.email }}</span>
      </label>

      <label>
        Mobile number <span class="optional">(E.164, e.g. +61412345678)</span>
        <input v-model.trim="form.mobileNumber" type="tel" required />
        <span v-if="fieldErrors.mobileNumber" class="field-error">{{ fieldErrors.mobileNumber }}</span>
      </label>

      <button type="submit" :disabled="status === 'submitting'">
        {{ id ? "Update agent" : "Create agent" }}
      </button>
    </form>

    <p v-if="status === 'error' && formError" class="form-error">{{ formError }}</p>

    <div v-if="status === 'success' && savedAgent" class="success">
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
