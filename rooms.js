/**
 * rooms.js
 * --------
 * Tracks which two sockets are currently paired together so we can
 * relay messages, handle "stop chat", and clean up on disconnect.
 */

/** @type {Map<string, {roomId: string, socketIds: string[], createdAt: number}>} */
const roomsById = new Map();
/** @type {Map<string, string>} socketId -> roomId */
const socketToRoom = new Map();

function createRoom(roomId, socketIdA, socketIdB) {
  roomsById.set(roomId, {
    roomId,
    socketIds: [socketIdA, socketIdB],
    createdAt: Date.now(),
  });
  socketToRoom.set(socketIdA, roomId);
  socketToRoom.set(socketIdB, roomId);
}

function getRoomForSocket(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;
  return roomsById.get(roomId) || null;
}

function getPartnerSocketId(socketId) {
  const room = getRoomForSocket(socketId);
  if (!room) return null;
  return room.socketIds.find((id) => id !== socketId) || null;
}

function destroyRoomForSocket(socketId) {
  const room = getRoomForSocket(socketId);
  if (!room) return null;
  room.socketIds.forEach((id) => socketToRoom.delete(id));
  roomsById.delete(room.roomId);
  return room;
}

function activeRoomCount() {
  return roomsById.size;
}

module.exports = {
  createRoom,
  getRoomForSocket,
  getPartnerSocketId,
  destroyRoomForSocket,
  activeRoomCount,
};
