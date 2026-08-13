import { NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost, forwardedParticipant, hostDeviceId } from "@/lib/peer-auth";
import { HOST_DEVICE_COOKIE } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revoke one enrolled device. Host-only; an enrolled device may revoke too,
 * including itself (the "sign this phone out" button), so we clear the cookie in
 * that case rather than leaving the browser holding a token the sandbox has
 * already forgotten.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  const { id } = await params;

  try {
    await client.revokeHostDevice(id, forwardedParticipant(req));
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "revoke failed", status);
  }

  const res = NextResponse.json({ ok: true });
  if (hostDeviceId(req) === id) {
    res.cookies.set({ name: HOST_DEVICE_COOKIE, value: "", path: "/", maxAge: 0 });
  }
  return res;
}
