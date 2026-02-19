const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; 

const HAND_HIERARCHY = ["Carte Haute", "Paire", "Double Paire", "Brelan", "Quinte", "Full", "Carré", "Quinte Flush"];

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    return deck.sort(() => Math.random() - 0.5);
}

// L'Arbitre : Vérifie si la combinaison est présente sur la table
function checkBid(allCards, combo, targetValue) {
    const valMap = {'7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};
    const counts = {};
    const suitVals = {'♠':[], '♣':[], '♥':[], '♦':[]};

    allCards.forEach(c => {
        let valStr = c.slice(0, -1);
        let suit = c.slice(-1);
        let v = valMap[valStr];
        counts[v] = (counts[v] || 0) + 1;
        suitVals[suit].push(v);
    });

    const targetV = valMap[targetValue];

    switch(combo) {
        case "Carte Haute": return counts[targetV] >= 1;
        case "Paire": return counts[targetV] >= 2;
        case "Double Paire":
            if ((counts[targetV] || 0) < 2) return false;
            for (let k in counts) if (k != targetV && counts[k] >= 2) return true;
            return false;
        case "Brelan": return counts[targetV] >= 3;
        case "Full":
            if ((counts[targetV] || 0) < 3) return false;
            for (let k in counts) if (k != targetV && counts[k] >= 2) return true;
            return false;
        case "Carré": return counts[targetV] >= 4;
        case "Quinte":
            for(let i=0; i<5; i++) if(!counts[targetV - i]) return false;
            return true;
        case "Quinte Flush":
            for (let s in suitVals) {
                let hasAll = true;
                for(let i=0; i<5; i++) if(!suitVals[s].includes(targetV - i)) hasAll = false;
                if (hasAll) return true;
            }
            return false;
        default: return false;
    }
}

function startNewRound(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    let activePlayers = room.players.filter(p => !p.isOut);
    
    // Si un seul joueur survit, il a gagné !
    if (activePlayers.length <= 1) {
        io.to(roomName).emit('gameOver', { winner: activePlayers[0].name });
        return;
    }

    room.deck = createDeck();
    room.currentBid = null;

    // Distribution selon les pénalités
    activePlayers.forEach(p => {
        p.cards = [];
        let cardsToDeal = 1 + p.penalties; 
        for(let i=0; i<cardsToDeal; i++) {
            if(room.deck.length > 0) p.cards.push(room.deck.pop());
        }
        io.to(p.id).emit('yourCards', p.cards);
    });

    // On s'assure que le joueur à qui c'est le tour n'est pas éliminé
    if (room.players[room.turnIndex].isOut) {
        room.turnIndex = room.players.findIndex(p => !p.isOut);
    }

    io.to(roomName).emit('roundStarted');
    io.to(roomName).emit('updateGameState', { 
        currentBid: null, 
        nextPlayer: room.players[room.turnIndex].name 
    });
    io.to(roomName).emit('updatePlayers', room.players);
}

io.on('connection', (socket) => {
    socket.emit('updateRooms', Object.keys(rooms));

    socket.on('createRoom', (roomName) => {
        if (!rooms[roomName]) {
            rooms[roomName] = { players: [], gameStarted: false, turnIndex: 0 };
            io.emit('updateRooms', Object.keys(rooms));
        }
    });

    socket.on('joinRoom', ({ roomName, playerName }) => {
        if (rooms[roomName] && !rooms[roomName].gameStarted) {
            socket.join(roomName);
            // On ajoute isOut et penalties
            rooms[roomName].players.push({ id: socket.id, name: playerName, cards: [], penalties: 0, isOut: false });
            io.to(roomName).emit('updatePlayers', rooms[roomName].players);
        }
    });

    socket.on('startGame', (roomName) => {
        if (rooms[roomName] && rooms[roomName].players.length >= 2) {
            rooms[roomName].gameStarted = true;
            rooms[roomName].turnIndex = 0;
            io.to(roomName).emit('gameStarted');
            startNewRound(roomName);
        }
    });

    socket.on('placeBid', ({ roomName, bid }) => {
        const room = rooms[roomName];
        if (room) {
            if (room.currentBid) {
                const oldIdx = HAND_HIERARCHY.indexOf(room.currentBid.combo);
                const newIdx = HAND_HIERARCHY.indexOf(bid.combo);
                if (newIdx < oldIdx) return; 
            }
            
            room.currentBid = bid;
            room.currentBid.playerId = socket.id; // On garde l'ID du parieur

            // On passe au prochain joueur NON éliminé
            do {
                room.turnIndex = (room.turnIndex + 1) % room.players.length;
            } while (room.players[room.turnIndex].isOut);

            io.to(roomName).emit('updateGameState', { currentBid: room.currentBid, nextPlayer: room.players[room.turnIndex].name });
        }
    });

    socket.on('callLiar', (roomName) => {
        const room = rooms[roomName];
        if (!room || !room.currentBid) return;

        let allCards = [];
        room.players.filter(p => !p.isOut).forEach(p => allCards = allCards.concat(p.cards));

        const isBidTrue = checkBid(allCards, room.currentBid.combo, room.currentBid.value);

        // Si l'annonce est VRAIE, celui qui a dit menteur (le joueur actuel) perd. Sinon le parieur perd.
        let loserId = isBidTrue ? room.players[room.turnIndex].id : room.currentBid.playerId;
        let loser = room.players.find(p => p.id === loserId);

        loser.penalties += 1;
        let eliminated = false;
        
        // Au bout de 5 pénalités (donc 6 cartes), il est éliminé
        if (loser.penalties >= 5) {
            loser.isOut = true;
            eliminated = true;
        }

        io.to(roomName).emit('revealAll', { 
            cards: allCards, 
            bidder: room.currentBid.playerName, 
            caller: room.players[room.turnIndex].name,
            loserName: loser.name,
            isBidTrue: isBidTrue,
            eliminated: eliminated
        });
        
        // Le perdant commence le prochain round
        room.turnIndex = room.players.findIndex(p => p.id === loserId);

        setTimeout(() => {
            startNewRound(roomName);
        }, 8000);
    });

    socket.on('disconnect', () => { /* Logique de déconnexion existante... */ });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));