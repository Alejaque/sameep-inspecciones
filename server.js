const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Crear directorios necesarios
const dirs = ['uploads', 'uploads/images', 'uploads/videos', 'uploads/documents', 'data'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const DB_FILE = './data/sameep.db';
let db = null;

// Inicializar base de datos SQL.js
async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_FILE)) {
        const fileBuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }
    
    // Crear tablas
    db.run(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            nombre_completo TEXT NOT NULL,
            rol TEXT NOT NULL DEFAULT 'inspector',
            email TEXT,
            telefono TEXT,
            activo INTEGER DEFAULT 1,
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_cuenta TEXT UNIQUE,
            nombre TEXT NOT NULL,
            dni TEXT,
            direccion TEXT NOT NULL,
            barrio TEXT,
            ciudad TEXT DEFAULT 'Resistencia',
            telefono TEXT,
            email TEXT,
            tipo_servicio TEXT DEFAULT 'agua_cloaca',
            estado_cuenta TEXT DEFAULT 'activo',
            observaciones TEXT,
            fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS inspecciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_acta TEXT UNIQUE NOT NULL,
            cliente_id INTEGER,
            inspector_id INTEGER NOT NULL,
            tipo_inspeccion TEXT NOT NULL,
            fecha_inspeccion DATETIME NOT NULL,
            direccion_inspeccion TEXT NOT NULL,
            descripcion TEXT NOT NULL,
            hallazgos TEXT,
            tipo_infraccion TEXT,
            gravedad TEXT DEFAULT 'leve',
            estado TEXT DEFAULT 'pendiente',
            medidor_numero TEXT,
            lectura_medidor TEXT,
            conexion_irregular INTEGER DEFAULT 0,
            bypass_detectado INTEGER DEFAULT 0,
            manipulacion_medidor INTEGER DEFAULT 0,
            conexion_clandestina INTEGER DEFAULT 0,
            fuga_detectada INTEGER DEFAULT 0,
            coordenadas_lat TEXT,
            coordenadas_lng TEXT,
            observaciones TEXT,
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
            fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS archivos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspeccion_id INTEGER NOT NULL,
            nombre_original TEXT NOT NULL,
            nombre_archivo TEXT NOT NULL,
            tipo TEXT NOT NULL,
            categoria TEXT DEFAULT 'evidencia',
            descripcion TEXT,
            tamaño INTEGER,
            fecha_subida DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS seguimientos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspeccion_id INTEGER NOT NULL,
            usuario_id INTEGER NOT NULL,
            accion TEXT NOT NULL,
            comentario TEXT,
            estado_anterior TEXT,
            estado_nuevo TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS multas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inspeccion_id INTEGER NOT NULL,
            cliente_id INTEGER,
            numero_multa TEXT UNIQUE,
            monto REAL,
            descripcion TEXT,
            estado TEXT DEFAULT 'pendiente',
            fecha_emision DATETIME,
            fecha_vencimiento DATETIME,
            fecha_pago DATETIME,
            observaciones TEXT,
            generada_por INTEGER,
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Guardar base de datos
    saveDatabase();
    
    // Crear usuarios por defecto
    const result = db.exec("SELECT COUNT(*) as c FROM usuarios");
    const userCount = result[0] ? result[0].values[0][0] : 0;
    
    if (userCount === 0) {
        const users = [
            ['admin', 'admin123', 'Administrador del Sistema', 'admin'],
            ['inspector1', 'inspector123', 'Inspector de Campo', 'inspector'],
            ['comercial1', 'comercial123', 'Personal Comercial', 'comercial'],
            ['jefe1', 'jefe123', 'Jefe de Sección', 'jefe']
        ];
        
        users.forEach(([username, password, nombre, rol]) => {
            const hash = bcrypt.hashSync(password, 10);
            db.run('INSERT INTO usuarios (username, password, nombre_completo, rol) VALUES (?, ?, ?, ?)', 
                   [username, hash, nombre, rol]);
        });
        
        saveDatabase();
        console.log('Usuarios por defecto creados');
    }
}

// Guardar base de datos a archivo
function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
}

// Helper para ejecutar queries
function queryAll(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (e) {
        console.error('Error en query:', e);
        return [];
    }
}

function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results[0] || null;
}

function queryRun(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        stmt.step();
        stmt.free();
        saveDatabase();
        // Obtener último ID insertado
        const idResult = db.exec("SELECT last_insert_rowid() as id");
        return { lastInsertRowid: idResult[0] ? idResult[0].values[0][0] : null };
    } catch (e) {
        console.error('Error en run:', e);
        return { lastInsertRowid: null, error: e.message };
    }
}

// Configuración
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'sameep-inspecciones-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Configuración de multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let folder = 'uploads/documents';
        if (file.mimetype.startsWith('image/')) folder = 'uploads/images';
        else if (file.mimetype.startsWith('video/')) folder = 'uploads/videos';
        cb(null, folder);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ 
    storage, 
    limits: { fileSize: 100 * 1024 * 1024 }
});

// Middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    res.redirect('/login');
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (roles.includes(req.session.userRole)) return next();
        res.status(403).json({ error: 'Sin permisos suficientes' });
    };
}

// ============ AUTENTICACIÓN ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = queryOne('SELECT * FROM usuarios WHERE username = ? AND activo = 1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    req.session.userId = user.id;
    req.session.userName = user.nombre_completo;
    req.session.userRole = user.rol;
    req.session.username = user.username;
    res.json({ success: true, user: { id: user.id, nombre: user.nombre_completo, rol: user.rol } });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.session.userId, nombre: req.session.userName, rol: req.session.userRole, username: req.session.username });
});

// ============ CLIENTES ============
app.get('/api/clientes', requireAuth, (req, res) => {
    const { buscar, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT * FROM clientes WHERE 1=1';
    const params = [];
    if (buscar) {
        sql += ' AND (nombre LIKE ? OR dni LIKE ? OR numero_cuenta LIKE ? OR direccion LIKE ?)';
        const term = `%${buscar}%`;
        params.push(term, term, term, term);
    }
    sql += ' ORDER BY fecha_registro DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const clientes = queryAll(sql, params);
    const totalResult = queryOne('SELECT COUNT(*) as count FROM clientes');
    res.json({ clientes, total: totalResult ? totalResult.count : 0 });
});

app.post('/api/clientes', requireAuth, (req, res) => {
    try {
        const { numero_cuenta, nombre, dni, direccion, barrio, ciudad, telefono, email, tipo_servicio, observaciones } = req.body;
        const result = queryRun(
            'INSERT INTO clientes (numero_cuenta, nombre, dni, direccion, barrio, ciudad, telefono, email, tipo_servicio, observaciones) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [numero_cuenta, nombre, dni, direccion, barrio, ciudad || 'Resistencia', telefono, email, tipo_servicio || 'agua_cloaca', observaciones]
        );
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/clientes/:id', requireAuth, (req, res) => {
    try {
        const { numero_cuenta, nombre, dni, direccion, barrio, ciudad, telefono, email, tipo_servicio, observaciones } = req.body;
        queryRun(
            'UPDATE clientes SET numero_cuenta=?, nombre=?, dni=?, direccion=?, barrio=?, ciudad=?, telefono=?, email=?, tipo_servicio=?, observaciones=? WHERE id=?',
            [numero_cuenta, nombre, dni, direccion, barrio, ciudad, telefono, email, tipo_servicio, observaciones, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/clientes/:id', requireAuth, (req, res) => {
    const cliente = queryOne('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const inspecciones = queryAll('SELECT * FROM inspecciones WHERE cliente_id = ? ORDER BY fecha_inspeccion DESC', [req.params.id]);
    const multas = queryAll('SELECT * FROM multas WHERE cliente_id = ? ORDER BY fecha_creacion DESC', [req.params.id]);
    res.json({ cliente, inspecciones, multas });
});

// ============ INSPECCIONES ============
app.get('/api/inspecciones', requireAuth, (req, res) => {
    const { estado, tipo, buscar } = req.query;
    let sql = `SELECT i.*, c.nombre as cliente_nombre, c.direccion as cliente_direccion, c.numero_cuenta, u.nombre_completo as inspector_nombre 
               FROM inspecciones i 
               LEFT JOIN clientes c ON i.cliente_id = c.id 
               LEFT JOIN usuarios u ON i.inspector_id = u.id 
               WHERE 1=1`;
    const params = [];
    if (estado) { sql += ' AND i.estado = ?'; params.push(estado); }
    if (tipo) { sql += ' AND i.tipo_inspeccion = ?'; params.push(tipo); }
    if (buscar) {
        sql += ' AND (i.numero_acta LIKE ? OR c.nombre LIKE ? OR i.direccion_inspeccion LIKE ? OR c.numero_cuenta LIKE ?)';
        const t = `%${buscar}%`;
        params.push(t, t, t, t);
    }
    sql += ' ORDER BY i.fecha_creacion DESC';
    const inspecciones = queryAll(sql, params);
    
    inspecciones.forEach(insp => {
        const archivos = queryOne('SELECT COUNT(*) as c FROM archivos WHERE inspeccion_id=?', [insp.id]);
        insp.archivos_count = archivos ? archivos.c : 0;
    });
    
    const total = inspecciones.length;
    res.json({ inspecciones, total });
});

app.get('/api/inspecciones/:id', requireAuth, (req, res) => {
    const inspeccion = queryOne(`
        SELECT i.*, c.nombre as cliente_nombre, c.direccion as cliente_direccion, c.numero_cuenta, c.dni as cliente_dni, c.telefono as cliente_telefono,
               u.nombre_completo as inspector_nombre 
        FROM inspecciones i 
        LEFT JOIN clientes c ON i.cliente_id = c.id 
        LEFT JOIN usuarios u ON i.inspector_id = u.id 
        WHERE i.id = ?
    `, [req.params.id]);
    
    if (!inspeccion) return res.status(404).json({ error: 'Inspección no encontrada' });
    
    const archivos = queryAll('SELECT * FROM archivos WHERE inspeccion_id = ? ORDER BY fecha_subida DESC', [req.params.id]);
    const seguimientos = queryAll(`
        SELECT s.*, u.nombre_completo as usuario_nombre 
        FROM seguimientos s 
        LEFT JOIN usuarios u ON s.usuario_id = u.id 
        WHERE s.inspeccion_id = ? ORDER BY s.fecha DESC
    `, [req.params.id]);
    const multas = queryAll('SELECT * FROM multas WHERE inspeccion_id = ?', [req.params.id]);
    
    res.json({ inspeccion, archivos, seguimientos, multas });
});

app.post('/api/inspecciones', requireAuth, (req, res) => {
    try {
        const data = req.body;
        const year = new Date().getFullYear();
        const countResult = queryOne("SELECT COUNT(*) as c FROM inspecciones WHERE numero_acta LIKE ?", [`ACTA-${year}%`]);
        const count = countResult ? countResult.c : 0;
        const numero_acta = `ACTA-${year}-${String(count + 1).padStart(5, '0')}`;
        
        const result = queryRun(`
            INSERT INTO inspecciones (numero_acta, cliente_id, inspector_id, tipo_inspeccion, fecha_inspeccion, direccion_inspeccion, 
            descripcion, hallazgos, tipo_infraccion, gravedad, estado, medidor_numero, lectura_medidor,
            conexion_irregular, bypass_detectado, manipulacion_medidor, conexion_clandestina, fuga_detectada,
            coordenadas_lat, coordenadas_lng, observaciones)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            numero_acta, data.cliente_id || null, req.session.userId, data.tipo_inspeccion, data.fecha_inspeccion,
            data.direccion_inspeccion, data.descripcion, data.hallazgos || '', data.tipo_infraccion || '', data.gravedad || 'leve',
            'pendiente', data.medidor_numero || '', data.lectura_medidor || '',
            data.conexion_irregular ? 1 : 0, data.bypass_detectado ? 1 : 0, data.manipulacion_medidor ? 1 : 0,
            data.conexion_clandestina ? 1 : 0, data.fuga_detectada ? 1 : 0,
            data.coordenadas_lat || '', data.coordenadas_lng || '', data.observaciones || ''
        ]);
        
        queryRun('INSERT INTO seguimientos (inspeccion_id, usuario_id, accion, comentario, estado_nuevo) VALUES (?,?,?,?,?)', 
                 [result.lastInsertRowid, req.session.userId, 'Creación', 'Acta de inspección creada', 'pendiente']);
        
        res.json({ success: true, id: result.lastInsertRowid, numero_acta });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/inspecciones/:id', requireAuth, (req, res) => {
    try {
        const data = req.body;
        const current = queryOne('SELECT estado FROM inspecciones WHERE id=?', [req.params.id]);
        
        queryRun(`
            UPDATE inspecciones SET cliente_id=?, tipo_inspeccion=?, fecha_inspeccion=?, direccion_inspeccion=?,
            descripcion=?, hallazgos=?, tipo_infraccion=?, gravedad=?, estado=?, medidor_numero=?, lectura_medidor=?,
            conexion_irregular=?, bypass_detectado=?, manipulacion_medidor=?, conexion_clandestina=?, fuga_detectada=?,
            coordenadas_lat=?, coordenadas_lng=?, observaciones=?, fecha_actualizacion=CURRENT_TIMESTAMP
            WHERE id=?
        `, [
            data.cliente_id, data.tipo_inspeccion, data.fecha_inspeccion, data.direccion_inspeccion,
            data.descripcion, data.hallazgos || '', data.tipo_infraccion || '', data.gravedad, data.estado,
            data.medidor_numero || '', data.lectura_medidor || '',
            data.conexion_irregular ? 1 : 0, data.bypass_detectado ? 1 : 0, data.manipulacion_medidor ? 1 : 0,
            data.conexion_clandestina ? 1 : 0, data.fuga_detectada ? 1 : 0,
            data.coordenadas_lat || '', data.coordenadas_lng || '', data.observaciones || '', req.params.id
        ]);
        
        if (current && current.estado !== data.estado) {
            queryRun('INSERT INTO seguimientos (inspeccion_id, usuario_id, accion, comentario, estado_anterior, estado_nuevo) VALUES (?,?,?,?,?,?)', 
                     [req.params.id, req.session.userId, 'Cambio de estado', data.comentario_seguimiento || '', current.estado, data.estado]);
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============ ARCHIVOS ============
app.post('/api/inspecciones/:id/archivos', requireAuth, upload.array('archivos', 20), (req, res) => {
    try {
        const files = req.files;
        const results = [];
        files.forEach(file => {
            let tipo = 'documento';
            if (file.mimetype.startsWith('image/')) tipo = 'imagen';
            else if (file.mimetype.startsWith('video/')) tipo = 'video';
            
            const result = queryRun(
                'INSERT INTO archivos (inspeccion_id, nombre_original, nombre_archivo, tipo, categoria, descripcion, tamaño) VALUES (?,?,?,?,?,?,?)',
                [req.params.id, file.originalname, file.filename, tipo, req.body.categoria || 'evidencia', req.body.descripcion || '', file.size]
            );
            results.push({ id: result.lastInsertRowid, nombre: file.originalname, tipo });
        });
        
        queryRun('INSERT INTO seguimientos (inspeccion_id, usuario_id, accion, comentario) VALUES (?,?,?,?)', 
                 [req.params.id, req.session.userId, 'Archivos adjuntados', `Se subieron ${files.length} archivo(s)`]);
        
        res.json({ success: true, archivos: results });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/archivos/:id', requireAuth, (req, res) => {
    try {
        const archivo = queryOne('SELECT * FROM archivos WHERE id=?', [req.params.id]);
        if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });
        
        let folder = 'uploads/documents';
        if (archivo.tipo === 'imagen') folder = 'uploads/images';
        else if (archivo.tipo === 'video') folder = 'uploads/videos';
        
        const filePath = path.join(folder, archivo.nombre_archivo);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        queryRun('DELETE FROM archivos WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============ SEGUIMIENTOS ============
app.post('/api/inspecciones/:id/seguimientos', requireAuth, (req, res) => {
    try {
        const { accion, comentario, nuevo_estado } = req.body;
        const current = queryOne('SELECT estado FROM inspecciones WHERE id=?', [req.params.id]);
        
        queryRun('INSERT INTO seguimientos (inspeccion_id, usuario_id, accion, comentario, estado_anterior, estado_nuevo) VALUES (?,?,?,?,?,?)', 
                 [req.params.id, req.session.userId, accion, comentario, current ? current.estado : '', nuevo_estado || (current ? current.estado : '')]);
        
        if (nuevo_estado && (!current || current.estado !== nuevo_estado)) {
            queryRun('UPDATE inspecciones SET estado=?, fecha_actualizacion=CURRENT_TIMESTAMP WHERE id=?', [nuevo_estado, req.params.id]);
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============ MULTAS ============
app.post('/api/multas', requireAuth, requireRole('admin', 'jefe', 'comercial'), (req, res) => {
    try {
        const data = req.body;
        const year = new Date().getFullYear();
        const countResult = queryOne("SELECT COUNT(*) as c FROM multas WHERE numero_multa LIKE ?", [`MULTA-${year}%`]);
        const count = countResult ? countResult.c : 0;
        const numero_multa = `MULTA-${year}-${String(count + 1).padStart(5, '0')}`;
        
        const result = queryRun(`
            INSERT INTO multas (inspeccion_id, cliente_id, numero_multa, monto, descripcion, estado, fecha_emision, fecha_vencimiento, observaciones, generada_por)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        `, [data.inspeccion_id, data.cliente_id, numero_multa, data.monto, data.descripcion, 'emitida', 
             new Date().toISOString(), data.fecha_vencimiento || '', data.observaciones || '', req.session.userId]);
        
        queryRun('UPDATE inspecciones SET estado=?, fecha_actualizacion=CURRENT_TIMESTAMP WHERE id=?', ['multa_emitida', data.inspeccion_id]);
        
        queryRun('INSERT INTO seguimientos (inspeccion_id, usuario_id, accion, comentario, estado_nuevo) VALUES (?,?,?,?,?)', 
                 [data.inspeccion_id, req.session.userId, 'Multa generada', `Multa ${numero_multa} por $${data.monto}`, 'multa_emitida']);
        
        res.json({ success: true, id: result.lastInsertRowid, numero_multa });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/multas', requireAuth, (req, res) => {
    const multas = queryAll(`
        SELECT m.*, c.nombre as cliente_nombre, c.numero_cuenta, i.numero_acta, u.nombre_completo as generada_por_nombre
        FROM multas m
        LEFT JOIN clientes c ON m.cliente_id = c.id
        LEFT JOIN inspecciones i ON m.inspeccion_id = i.id
        LEFT JOIN usuarios u ON m.generada_por = u.id
        ORDER BY m.fecha_creacion DESC
    `);
    res.json({ multas });
});

// ============ DASHBOARD ============
app.get('/api/dashboard', requireAuth, (req, res) => {
    const get = (sql, params = []) => {
        const r = queryOne(sql, params);
        return r ? r.c || r.total || 0 : 0;
    };
    
    const stats = {
        total_inspecciones: get('SELECT COUNT(*) as c FROM inspecciones'),
        pendientes: get("SELECT COUNT(*) as c FROM inspecciones WHERE estado='pendiente'"),
        en_revision: get("SELECT COUNT(*) as c FROM inspecciones WHERE estado='en_revision'"),
        derivadas_comercial: get("SELECT COUNT(*) as c FROM inspecciones WHERE estado='derivada_comercial'"),
        con_multa: get("SELECT COUNT(*) as c FROM inspecciones WHERE estado='multa_emitida'"),
        resueltas: get("SELECT COUNT(*) as c FROM inspecciones WHERE estado='resuelta'"),
        total_clientes: get('SELECT COUNT(*) as c FROM clientes'),
        total_multas: get('SELECT COUNT(*) as c FROM multas'),
        monto_multas: get('SELECT COALESCE(SUM(monto),0) as total FROM multas'),
        fraudes_detectados: get('SELECT COUNT(*) as c FROM inspecciones WHERE conexion_clandestina=1 OR bypass_detectado=1 OR manipulacion_medidor=1'),
        inspecciones_mes: get("SELECT COUNT(*) as c FROM inspecciones WHERE fecha_inspeccion >= date('now', 'start of month')"),
        ultimas_inspecciones: queryAll(`
            SELECT i.*, c.nombre as cliente_nombre, u.nombre_completo as inspector_nombre 
            FROM inspecciones i 
            LEFT JOIN clientes c ON i.cliente_id = c.id 
            LEFT JOIN usuarios u ON i.inspector_id = u.id 
            ORDER BY i.fecha_creacion DESC LIMIT 10
        `),
        por_tipo: queryAll('SELECT tipo_inspeccion, COUNT(*) as cantidad FROM inspecciones GROUP BY tipo_inspeccion'),
        por_gravedad: queryAll('SELECT gravedad, COUNT(*) as cantidad FROM inspecciones GROUP BY gravedad')
    };
    res.json(stats);
});

// ============ USUARIOS ============
app.get('/api/usuarios', requireAuth, requireRole('admin', 'jefe'), (req, res) => {
    const usuarios = queryAll('SELECT id, username, nombre_completo, rol, email, telefono, activo, fecha_creacion FROM usuarios ORDER BY nombre_completo');
    res.json({ usuarios });
});

app.post('/api/usuarios', requireAuth, requireRole('admin'), (req, res) => {
    try {
        const { username, password, nombre_completo, rol, email, telefono } = req.body;
        const hash = bcrypt.hashSync(password, 10);
        const result = queryRun('INSERT INTO usuarios (username, password, nombre_completo, rol, email, telefono) VALUES (?,?,?,?,?,?)', 
                                [username, hash, nombre_completo, rol, email || '', telefono || '']);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ============ FRONTEND ============
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public'));

app.get('*', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar
initDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚰 SAMEEP - Sistema de Inspecciones`);
        console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
        console.log(`\n📋 Usuarios por defecto:`);
        console.log(`   Admin:     admin / admin123`);
        console.log(`   Inspector: inspector1 / inspector123`);
        console.log(`   Comercial: comercial1 / comercial123`);
        console.log(`   Jefe:      jefe1 / jefe123\n`);
    });
}).catch(err => {
    console.error('Error al iniciar:', err);
});