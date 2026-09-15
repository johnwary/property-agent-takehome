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
// brief, list/delete stay curl-only (see apps/api/README.md) - this form
// only creates and updates, so it needs the target id typed in by hand for
// an update rather than a picker sourced from a list endpoint the UI never calls.
const id = ref("");
const form = reactive<AgentInput>({
  firstName: "",
  lastName: "",
  email: "",
  mobileNumber: "",
});

// The ETag for `id`, so PUT can send If-Match without the form ever
// exposing a "revision" field to edit or forge. Keyed by id (not just held
// as a bare string) so switching to a different id can't accidentally reuse
// a stale tag from whichever agent was loaded before it.
const knownETags = reactive<Record<string, string>>({});

// isSubmitting gates the button and guards against a second request firing
// mid-flight; status only picks which message to render. Keeping them
// separate matters because resetMessages() runs on every keystroke in the
// id field - if it also touched isSubmitting, editing the id while a
// request was in flight would re-enable the button, let a second request
// start, and whichever response lands second would silently overwrite the
// first one's result.
type Status = "idle" | "success" | "error" | "conflict";
const status = ref<Status>("idle");
const isSubmitting = ref(false);
const fieldErrors = ref<Partial<Record<keyof AgentInput, string>>>({});
const formError = ref("");
const savedAgent = ref<Agent | null>(null);
// Set only after a 412, by reloadAfterConflict(), so the user can compare
// the version that beat them against what they still have typed above.
const currentOnServer = ref<Agent | null>(null);

function resetMessages() {
  status.value = "idle";
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;
  currentOnServer.value = null;
}

/**
 * GETs the agent to learn its current ETag - needed the first time this
 * form edits an id it did not itself just create or update, since If-Match
 * has no value to send otherwise. Returns null (and reports 404 like any
 * other failure) if the id doesn't exist.
 */
async function fetchETag(agentId: string): Promise<string | null> {
  const res = await fetch(`/agents/${agentId}`);
  if (!res.ok) return null;
  const etag = res.headers.get("etag");
  if (etag) knownETags[agentId] = etag;
  return etag;
}

/**
 * Reload the agent the user was trying to save, without touching what they
 * typed - a 412 means someone else's edit is now current, and the form's
 * job is to show that and let the user compare, not to silently discard
 * their in-progress changes by refetching over the top of the form fields.
 */
async function reloadAfterConflict() {
  const agentId = id.value.trim();
  if (!agentId) return;
  const res = await fetch(`/agents/${agentId}`);
  if (!res.ok) return;
  const etag = res.headers.get("etag");
  if (etag) knownETags[agentId] = etag;
  currentOnServer.value = (await res.json()) as Agent;
}

async function submit() {
  if (isSubmitting.value) return;
  isSubmitting.value = true;
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;
  currentOnServer.value = null;

  const agentId = id.value.trim();
  const isUpdate = agentId.length > 0;

  try {
    // PUT requires If-Match (see apps/api/README.md "Optimistic
    // concurrency"). This form only ever learns an id's ETag from its own
    // prior create/update in this session, so the first time it edits an id
    // it didn't just save itself - pasted in by hand - there is nothing
    // cached yet. One GET fills that in; a missing agent surfaces as the
    // same 404 the PUT would have given anyway.
    let ifMatch: string | undefined;
    if (isUpdate) {
      ifMatch = knownETags[agentId];
      if (!ifMatch) {
        const fetched = await fetchETag(agentId);
        if (!fetched) {
          status.value = "error";
          formError.value = "agent not found";
          return;
        }
        ifMatch = fetched;
      }
    }

    const res = await fetch(isUpdate ? `/agents/${agentId}` : "/agents", {
      method: isUpdate ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        ...(ifMatch ? { "if-match": ifMatch } : {}),
      },
      body: JSON.stringify(form),
    });

    if (res.ok) {
      const saved = (await res.json()) as Agent;
      const nextETag = res.headers.get("etag");
      // Refresh the cached tag from this response, not the one that was
      // just spent - a second save in the same session must send the
      // revision this write produced, or it fails as if it were stale.
      if (nextETag) knownETags[saved.id] = nextETag;
      savedAgent.value = saved;
      status.value = "success";
      return;
    }

    if (res.status === 412) {
      // Someone else's write landed first. The cached tag is now wrong for
      // every future save too, not just this one - drop it so the next
      // attempt (after the user reloads and reapplies) re-fetches instead
      // of retrying the same stale value.
      delete knownETags[agentId];
      status.value = "conflict";
      formError.value = "This agent was changed by someone else since you loaded it.";
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

    <div v-if="status === 'conflict'" class="conflict" role="alert">
      <p>{{ formError }}</p>
      <p>
        What you typed above is untouched. Reload to see the current version, then
        reapply your changes and save again.
      </p>
      <button type="button" @click="reloadAfterConflict">Reload current version</button>
      <pre v-if="currentOnServer">{{ JSON.stringify(currentOnServer, null, 2) }}</pre>
    </div>

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

.conflict {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid #b06b00;
  border-radius: 4px;
  background: #fff8ec;
}

.conflict p {
  margin: 0 0 0.5rem;
}

.conflict button {
  padding: 0.4rem 1rem;
  font: inherit;
  cursor: pointer;
}

.conflict pre {
  margin-top: 0.75rem;
  background: #f5f5f5;
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
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
