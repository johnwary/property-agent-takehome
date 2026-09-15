<script setup lang="ts">
import { computed, reactive, ref } from "vue";
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
type Status = "idle" | "loaded" | "success" | "error" | "conflict";
const status = ref<Status>("idle");
const isSubmitting = ref(false);
const isLoading = ref(false);
const fieldErrors = ref<Partial<Record<keyof AgentInput, string>>>({});
const formError = ref("");
const savedAgent = ref<Agent | null>(null);
// Set only after a 412, by reloadAfterConflict(), so the user can compare
// the version that beat them against what they still have typed above.
const currentOnServer = ref<Agent | null>(null);
// The agent as loaded, to confirm which record the form is now editing.
const loadedAgent = ref<Agent | null>(null);
// Error from the conflict box's own reload, kept separate from formError so a
// failed reload cannot overwrite the "changed by someone else" explanation
// the box is built around.
const reloadError = ref("");

/**
 * Whether the form holds a tag for the id currently typed in. Editing the id
 * to something unloaded makes this false, which is what stops a PUT built
 * from one agent's fields being sent at another agent.
 */
const hasLoadedTag = computed(() => !!knownETags[id.value.trim()]);

function resetMessages() {
  status.value = "idle";
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;
  currentOnServer.value = null;
  loadedAgent.value = null;
  reloadError.value = "";
}

/**
 * Loads an agent into the form: fills the fields AND captures its ETag.
 *
 * The two must happen together. An ETag fetched without showing the user
 * the data it describes is a rubber stamp - If-Match would assert "I am
 * editing this revision" about a version nobody ever saw, and a colleague's
 * edit made in between would be overwritten with a 200. So the tag is only
 * ever acquired here, alongside the fields it belongs to.
 */
async function loadAgent() {
  const agentId = id.value.trim();
  if (!agentId || isLoading.value) return;
  isLoading.value = true;
  resetMessages();

  try {
    const res = await fetch(`/agents/${agentId}`);
    if (!res.ok) {
      status.value = "error";
      formError.value = res.status === 404 ? "agent not found" : "could not load that agent";
      return;
    }

    const agent = (await res.json()) as Agent;
    const etag = res.headers.get("etag");
    // No ETag means a later PUT could not be conditional, so treat it as a
    // failed load rather than filling the form with data we can't safely save.
    if (!etag) {
      status.value = "error";
      formError.value = "could not load that agent";
      return;
    }

    knownETags[agentId] = etag;
    form.firstName = agent.firstName;
    form.lastName = agent.lastName;
    form.email = agent.email;
    form.mobileNumber = agent.mobileNumber;
    status.value = "loaded";
    loadedAgent.value = agent;
  } catch {
    status.value = "error";
    formError.value = "could not reach the server";
  } finally {
    isLoading.value = false;
  }
}

/**
 * Reload the agent the user was trying to save, without touching what they
 * typed - a 412 means someone else's edit is now current, and the form's
 * job is to show that and let the user compare, not to silently discard
 * their in-progress changes by refetching over the top of the form fields.
 */
async function reloadAfterConflict() {
  const agentId = id.value.trim();
  if (!agentId || isLoading.value) return;
  isLoading.value = true;
  reloadError.value = "";

  try {
    const res = await fetch(`/agents/${agentId}`);
    if (!res.ok) {
      reloadError.value = "could not load the current version";
      return;
    }
    const etag = res.headers.get("etag");
    const agent = (await res.json()) as Agent;
    // Refreshing the tag here is what lets the user save their own version
    // over the one shown. That is deliberate: unlike a blind save, the
    // competing record is displayed right below, so keeping their edit is an
    // informed choice rather than an overwrite they never knew they made.
    if (etag) knownETags[agentId] = etag;
    currentOnServer.value = agent;
  } catch {
    reloadError.value = "could not reach the server";
  } finally {
    isLoading.value = false;
  }
}

async function submit() {
  if (isSubmitting.value) return;
  isSubmitting.value = true;
  fieldErrors.value = {};
  formError.value = "";
  savedAgent.value = null;
  currentOnServer.value = null;
  loadedAgent.value = null;
  reloadError.value = "";

  const agentId = id.value.trim();
  const isUpdate = agentId.length > 0;

  try {
    // PUT requires If-Match (see apps/api/README.md "Optimistic
    // concurrency"), and the only legitimate source for that tag is a load
    // the user actually saw. Fetching it here instead would make the check
    // meaningless: it would assert "I am editing the current revision"
    // about data never shown, so an edit that landed while the user typed
    // would be overwritten with a 200. Refuse instead, and point at Load.
    let ifMatch: string | undefined;
    if (isUpdate) {
      ifMatch = knownETags[agentId];
      if (!ifMatch) {
        status.value = "error";
        formError.value = "Load this agent first, so your changes apply to the version you can see.";
        return;
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
      Create a new agent, or load an existing <code>id</code> to update one.
      Listing and deleting are curl-only - see
      <code>apps/api/README.md</code>.
    </p>

    <form @submit.prevent="submit">
      <label for="agent-id">
        Agent id <span class="optional">(leave blank to create)</span>
        <span class="id-row">
          <input id="agent-id" v-model.trim="id" type="text" placeholder="existing agent id" @input="resetMessages" />
          <button type="button" :disabled="!id || isLoading || isSubmitting" @click="loadAgent">
            {{ isLoading ? "Loading..." : "Load" }}
          </button>
        </span>
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

      <!-- An id with no loaded tag cannot be saved conditionally, so the
           button is disabled rather than letting a click discover that. -->
      <button type="submit" :disabled="isSubmitting || isLoading || (!!id && !hasLoadedTag)">
        {{ id ? "Update agent" : "Create agent" }}
      </button>
      <p v-if="!!id && !hasLoadedTag" class="hint needs-load">
        Press Load to fetch this agent before updating it.
      </p>
    </form>

    <p v-if="status === 'error' && formError" class="form-error" role="alert">{{ formError }}</p>

    <div v-if="status === 'loaded' && loadedAgent" class="loaded" role="status">
      <p>Loaded. Edit the fields above and save.</p>
      <pre>{{ JSON.stringify(loadedAgent, null, 2) }}</pre>
    </div>

    <div v-if="status === 'conflict'" class="conflict" role="alert">
      <p>{{ formError }}</p>
      <p>
        What you typed above is untouched. Reload to see the current version, then
        reapply your changes and save again.
      </p>
      <button type="button" :disabled="isLoading" @click="reloadAfterConflict">
        {{ isLoading ? "Loading..." : "Reload current version" }}
      </button>
      <p v-if="reloadError" class="form-error">{{ reloadError }}</p>
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

/* Input and its Load button side by side, wrapping on narrow screens. */
.id-row {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.id-row input {
  flex: 1 1 auto;
  min-width: 0;
}

.id-row button {
  flex: 0 0 auto;
  padding: 0.4rem 1rem;
  font: inherit;
  cursor: pointer;
}

.needs-load {
  margin: -0.5rem 0 0;
}

.loaded {
  margin-top: 1rem;
}

.loaded pre {
  background: #f5f5f5;
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
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
