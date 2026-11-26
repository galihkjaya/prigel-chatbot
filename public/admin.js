const signIn = document.querySelector('#sign-in');
const signInForm = document.querySelector('#sign-in-form');
const password = document.querySelector('#password');
const signInError = document.querySelector('#sign-in-error');
const workspace = document.querySelector('#workspace');
const uploadForm = document.querySelector('#upload-form');
const uploadButton = uploadForm.querySelector('button');
const uploadStatus = document.querySelector('#upload-status');
const uploadError = document.querySelector('#upload-error');
const signOutButton = document.querySelector('#sign-out');
const resourceList = document.querySelector('#resource-list');
const noResources = document.querySelector('#no-resources');
const resourceCount = document.querySelector('#resource-count');
const dates = new Intl.DateTimeFormat('en', { dateStyle: 'long' });
let credential;
let resources = [];

function notice(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

async function requestResources(key, options) {
  const response = await fetch('/api/resources', {
    ...options,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Incorrect password. Please sign in again.', { cause: response.status });
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete the request. Please try again.');
  return data;
}

function errorMessage(error) {
  return error instanceof SyntaxError || error instanceof TypeError
    ? 'Could not reach the server. Please try again.'
    : error.message;
}

function renderResources() {
  resourceCount.textContent = `${resources.length} ${resources.length === 1 ? 'file' : 'files'}`;
  noResources.hidden = Boolean(resources.length);
  resourceList.replaceChildren();

  for (const resource of resources) {
    const item = document.createElement('li');
    const name = document.createElement('h3');
    name.textContent = resource.name;

    const meta = document.createElement('p');
    const format = resource.type === 'md' ? 'Markdown' : 'PDF';
    const uploadedAt = new Date(resource.uploadedAt);
    const date = Number.isNaN(uploadedAt.getTime()) ? '' : dates.format(uploadedAt);
    const skipped = resource.emptyPages > 0 ? `${resource.emptyPages} ${resource.emptyPages === 1 ? 'page' : 'pages'} without text` : '';
    meta.textContent = [format, `${resource.chunks} ${resource.chunks === 1 ? 'excerpt' : 'excerpts'}`, date, skipped].filter(Boolean).join(' · ');

    item.append(name, meta);
    resourceList.append(item);
  }
}

function signOut(message) {
  credential = undefined;
  resources = [];
  renderResources();
  uploadForm.reset();
  notice(uploadStatus);
  notice(uploadError);
  workspace.hidden = true;
  signIn.hidden = false;
  notice(signInError, message);
  password.focus();
}

signOutButton.addEventListener('click', () => signOut());

signInForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = signInForm.querySelector('button');
  if (button.disabled) return;

  const key = password.value;
  button.disabled = true;
  notice(signInError);
  try {
    const data = await requestResources(key);
    credential = key;
    resources = data.resources;
    renderResources();
    signInForm.reset();
    signIn.hidden = true;
    workspace.hidden = false;
    document.querySelector('#file').focus();
  } catch (error) {
    notice(signInError, errorMessage(error));
  } finally {
    button.disabled = false;
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (uploadButton.disabled || !credential) return;

  uploadButton.disabled = true;
  signOutButton.disabled = true;
  notice(uploadError);
  notice(uploadStatus, 'Uploading and processing the file…');
  try {
    const { resource } = await requestResources(credential, {
      method: 'POST', body: new FormData(uploadForm),
    });
    resources = [resource, ...resources.filter(({ id }) => id !== resource.id)];
    renderResources();
    uploadForm.reset();
    notice(uploadStatus, `${resource.name} was added.`);
  } catch (error) {
    notice(uploadStatus);
    if (error.cause === 401 || error.cause === 403) signOut(error.message);
    else notice(uploadError, errorMessage(error));
  } finally {
    uploadButton.disabled = false;
    signOutButton.disabled = false;
  }
});
