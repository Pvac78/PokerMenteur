const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; 

io.on('connection', (socket) => {
    console.log('Un utilisateur est connecté:', socket.id);

    // Envoyer la liste des tables à l'arrivée
    socket.emit('updateRooms', Object.keys(rooms));

    socket.on('createRoom', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = { players: [], gameStarted: false };
            io.emit('updateRooms', Object.keys(rooms));
        }
    });

    socket.on('joinRoom', ({ roomName, playerName }) => {
        if (rooms[roomName] && !rooms[roomName].gameStarted) {
            socket.join(roomName);
            rooms[roomName].players.push({ id: socket.id, name: playerName, cards: [] });
            io.to(roomName).emit('updatePlayers', rooms[roomName].players);
        }
    });

    socket.on('startGame', (roomName) => {
        if (rooms[roomName] && rooms[roomName].players.length >= 2) {
            rooms[roomName].gameStarted = true;
            io.to(roomName).emit('gameStarted');
        }
    });

    socket.on('disconnect', () => {
        for (const roomName in rooms) {
            const room = rooms[roomName];
            const index = room.players.findIndex(p => p.id === socket.id);
            
            if (index !== -1) {
                room.players.splice(index, 1);
                
                // Si la table est vide, on la supprime
                if (room.players.length === 0) {
                    delete rooms[roomName];
                    console.log(`Table supprimée : ${roomName}`);
                } else {
                    io.to(roomName).emit('updatePlayers', room.players);
                }
                
                // Mise à jour globale de la liste des tables
                io.emit('updateRooms', Object.keys(rooms));
                break;
            }
        }
    });
});

// Port dynamique pour Render ou 3001 en local
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});