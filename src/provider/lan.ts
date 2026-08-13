import { updateLanState } from "../lan/state";

export const recordLanPeerSuccess = async (
  providerRoot: string,
  peerId: string
): Promise<void> => {
  await updateLanState(providerRoot, (state) => {
    const peer = state.outboundPeers.find(
      (candidate) => candidate.peerId === peerId
    );
    if (peer) {
      peer.lastSuccessAt = new Date().toISOString();
      peer.updatedAt = peer.lastSuccessAt;
    }
  });
};
