import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchImages } from '$lib/server/services/image-search';
import { verifyServiceAssertion } from '$lib/server/auth/hooks';
import { db } from '$lib/server/db';
import { conversations } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
  const user = event.locals.user ?? null;

  if (!user && !event.request.headers.get('authorization')) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { query, conversationId } = body as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return json({ error: 'query is required' }, { status: 400 });
  }

  const serviceAssertion =
    user === null
      ? verifyServiceAssertion(event.request.headers.get('authorization'))
      : null;
  if (user === null && (!serviceAssertion || !serviceAssertion.valid)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const effectiveUserId = user?.id ?? serviceAssertion?.claims.userId ?? null;
  if (!effectiveUserId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (typeof conversationId === 'string' && conversationId.trim().length > 0) {
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    if (!conversation || conversation.userId !== effectiveUserId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const results = await searchImages(query.trim());
    return json({ results });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Image search failed';
    return json({ error: errorMessage }, { status: 500 });
  }
};
