// What docker recorded about a container that is no longer running, for a wait
// strategy to report instead of polling a dead container to its deadline.

/**
 * @param {{inspect?: Function}} container a dockerode container, as testcontainers
 *   hands it to a wait strategy
 * @returns {Promise<string|null>} `status=… exitCode=…`, or null while the container
 *   runs, has not started, or cannot be inspected (neither is evidence of a death)
 */
export async function deathReport(container) {
  if (!container || typeof container.inspect !== 'function') return null;
  let state;
  try {
    ({ State: state } = await container.inspect());
  } catch {
    return null;
  }
  if (!state || state.Running || state.Status === 'created') return null;
  const parts = [`status=${state.Status}`, `exitCode=${state.ExitCode}`];
  if (state.OOMKilled) parts.push('OOMKilled=true');
  if (state.Error) parts.push(`error=${state.Error}`);
  return parts.join(' ');
}
