// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * EPIMELEIA V3.3 — "Blindaje Digital"
 * Notario Digital de Conducta Ambiental Corporativa
 * Red: Polygon Mainnet (Chain ID: 137)
 *
 * Módulos:
 * 1. Registro de activos certificables con declaración completa
 * 2. Verificación por email corporativo (hash)
 * 3. Billing trimestral automático (Chainlink Automation)
 * 4. Certificación trimestral Q con firma de oráculo
 * 5. Gestión de oráculos autorizados
 * 6. Sucesión del founder (2 pasos)
 * 7. Cancelación con reembolso
 *
 * Niveles de Validación (frecuencia trimestral):
 * PV-L1: Sentinel/Copernicus — operativo hoy — USD 450/trimestre
 * PV-L2: Satelital comercial + validación cruzada — bajo acuerdo
 * PV-L3: Triple fuente independiente — bajo acuerdo
 *
 * Fee registro: USD 1,500 · Contacto: info@epimeleia.world
 */

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

contract EpimeleiaV33 is AutomationCompatibleInterface {

    // ─── OWNER ───────────────────────────────────────────
    address public founder;
    address public pendingFounder;

    // ─── FEES ────────────────────────────────────────────
    uint256 public registrationFee;
    uint256 public trimestralFee_L1;
    uint256 public trimestralFee_L2;
    uint256 public trimestralFee_L3;

    // ─── ENUMS ───────────────────────────────────────────
    enum PVLevel { L1, L2, L3 }
    enum CertStatus { PENDIENTE, CERTIFICADO, HUECO_OPACIDAD }
    enum TipoActividad {
        MINERIA,
        FORESTAL,
        NAVAL,
        INDUSTRIAL,
        DATA_CENTER,
        RESIDUOS,
        HIDROVIA,
        OTRO
    }

    // ─── NIVEL DESCRIPTIONS (on-chain) ───────────────────
    string public constant PV_L1_DESC = "Certificacion trimestral Sentinel/Copernicus. Operativo hoy.";
    string public constant PV_L2_DESC = "Certificacion trimestral satelital comercial + validacion cruzada. Bajo acuerdo previo.";
    string public constant PV_L3_DESC = "Certificacion trimestral triple fuente independiente. Bajo acuerdo previo.";

    // ─── STRUCTS ─────────────────────────────────────────
    struct Activo {
        bool activo;
        PVLevel nivel;
        TipoActividad tipoActividad;
        CertStatus estadoCert;
        uint256 saldo;
        uint256 ultimoBilling;
        uint256 diasContinuidad;
        uint256 fechaRegistro;
        uint256 ultimaCertQ;
        int256 latitud;
        int256 longitud;
        uint256 radioKm;
        bytes32 emailHash;
        string nombre;
    }

    struct CertificacionQ {
        uint256 timestamp;
        uint256 trimestre;
        bytes32 hashEvidencia;
        address oraculo;
        PVLevel nivel;
        TipoActividad tipoActividad;
        string metadataURI;
        bool valida;
    }

    struct HuecoOpacidad {
        uint256 diaInicio;
        uint256 diaFin;
        uint256 timestamp;
        string causa;
    }

    // ─── STORAGE ─────────────────────────────────────────
    mapping(address => Activo) public activos;
    mapping(address => CertificacionQ[]) public certificaciones;
    mapping(address => HuecoOpacidad[]) public huecos;
    mapping(address => bool) public oraculos;
    mapping(bytes32 => bool) public emailsVerificados;
    mapping(bytes32 => address) public codigosVerificacion;

    address[] public listaActivos;

    // ─── EVENTS ──────────────────────────────────────────
    event ActivoRegistrado(address indexed wallet, string nombre, TipoActividad tipo, PVLevel nivel, uint256 timestamp);
    event BillingEjecutado(address indexed wallet, uint256 monto, uint256 timestamp);
    event CertificacionRealizada(address indexed wallet, bytes32 hashEvidencia, uint256 trimestre, uint256 timestamp);
    event HuecoOpacidadRegistrado(address indexed wallet, uint256 dia, string causa, uint256 timestamp);
    event ActivoCancelado(address indexed wallet, uint256 reembolso, uint256 timestamp);
    event OraculoAutorizado(address indexed oraculo, bool estado);
    event SucesionIniciada(address indexed pendingFounder);
    event SucesionConfirmada(address indexed nuevoFounder);
    event ModeSuspension(bool activo, uint256 timestamp);
    event FeeAjustado(string tipo, uint256 nuevoValor);
    event EmailVerificado(address indexed wallet, bytes32 emailHash);

    // ─── SUSPENSION ──────────────────────────────────────
    bool public modeSuspension;

    // ─── MODIFIERS ───────────────────────────────────────
    modifier soloFounder() {
        require(msg.sender == founder, "Solo founder");
        _;
    }

    modifier soloOraculo() {
        require(oraculos[msg.sender], "Solo oraculo autorizado");
        _;
    }

    modifier activoActivo(address wallet) {
        require(activos[wallet].activo, "Activo no registrado");
        _;
    }

    modifier noSuspension() {
        require(!modeSuspension, "Sistema en Modo Suspension");
        _;
    }

    // ─── CONSTRUCTOR ─────────────────────────────────────
    constructor(
        uint256 _registrationFee,
        uint256 _trimestralFee_L1,
        uint256 _trimestralFee_L2,
        uint256 _trimestralFee_L3
    ) {
        founder = msg.sender;
        registrationFee = _registrationFee;
        trimestralFee_L1 = _trimestralFee_L1;
        trimestralFee_L2 = _trimestralFee_L2;
        trimestralFee_L3 = _trimestralFee_L3;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 1 — REGISTRO DE ACTIVOS
    // ═══════════════════════════════════════════════════

    function registrarActivo(
        string calldata nombre,
        TipoActividad tipoActividad,
        PVLevel nivel,
        int256 latitud,
        int256 longitud,
        uint256 radioKm,
        bytes32 emailHash
    ) external payable noSuspension {
        require(!activos[msg.sender].activo, "Ya registrado");
        require(msg.value >= registrationFee, "Fee insuficiente");
        require(emailsVerificados[emailHash], "Email no verificado");
        require(radioKm > 0 && radioKm <= 500, "Radio invalido");

        _crearActivo(nombre, tipoActividad, nivel, latitud, longitud, radioKm, emailHash);
        _transferirFounder(registrationFee);
        emit ActivoRegistrado(msg.sender, nombre, tipoActividad, nivel, block.timestamp);
    }

    function _crearActivo(
        string calldata nombre,
        TipoActividad tipoActividad,
        PVLevel nivel,
        int256 latitud,
        int256 longitud,
        uint256 radioKm,
        bytes32 emailHash
    ) internal {
        activos[msg.sender].activo = true;
        activos[msg.sender].nombre = nombre;
        activos[msg.sender].tipoActividad = tipoActividad;
        activos[msg.sender].nivel = nivel;
        activos[msg.sender].latitud = latitud;
        activos[msg.sender].longitud = longitud;
        activos[msg.sender].radioKm = radioKm;
        activos[msg.sender].emailHash = emailHash;
        activos[msg.sender].saldo = msg.value - registrationFee;
        activos[msg.sender].ultimoBilling = block.timestamp;
        activos[msg.sender].fechaRegistro = block.timestamp;
        activos[msg.sender].estadoCert = CertStatus.PENDIENTE;
        listaActivos.push(msg.sender);
    }

    function cargarSaldo() external payable activoActivo(msg.sender) {
        activos[msg.sender].saldo += msg.value;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 2 — VERIFICACIÓN EMAIL CORPORATIVO
    // ═══════════════════════════════════════════════════

    function registrarCodigoVerificacion(bytes32 codigo, address wallet) external soloFounder {
        codigosVerificacion[codigo] = wallet;
    }

    function verificarEmail(bytes32 codigo, bytes32 emailHash) external {
        require(codigosVerificacion[codigo] == msg.sender, "Codigo invalido");
        emailsVerificados[emailHash] = true;
        delete codigosVerificacion[codigo];
        emit EmailVerificado(msg.sender, emailHash);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 3 — BILLING TRIMESTRAL (Chainlink Automation)
    // ═══════════════════════════════════════════════════

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint i = 0; i < listaActivos.length; i++) {
            address w = listaActivos[i];
            Activo storage a = activos[w];
            if (a.activo && block.timestamp >= a.ultimoBilling + 90 days) {
                upkeepNeeded = true;
                performData = abi.encode(w);
                return (upkeepNeeded, performData);
            }
        }
        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external override {
        address wallet = abi.decode(performData, (address));
        _ejecutarBilling(wallet);
    }

    function _ejecutarBilling(address wallet) internal {
        Activo storage a = activos[wallet];
        if (!a.activo) return;
        if (block.timestamp < a.ultimoBilling + 90 days) return;

        uint256 fee = _getFeeNivel(a.nivel);

        if (a.saldo >= fee) {
            a.saldo -= fee;
            a.ultimoBilling = block.timestamp;
            _transferirFounder(fee);
            emit BillingEjecutado(wallet, fee, block.timestamp);
        } else {
            _cancelarActivo(wallet);
        }
    }

    function _getFeeNivel(PVLevel nivel) internal view returns (uint256) {
        if (nivel == PVLevel.L1) return trimestralFee_L1;
        if (nivel == PVLevel.L2) return trimestralFee_L2;
        return trimestralFee_L3;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 4 — CERTIFICACIÓN TRIMESTRAL Q
    // ═══════════════════════════════════════════════════

    function certificarQ(
        address wallet,
        bytes32 hashEvidencia,
        string calldata metadataURI,
        uint256 trimestre
    ) external soloOraculo activoActivo(wallet) noSuspension {

        certificaciones[wallet].push(CertificacionQ({
            timestamp: block.timestamp,
            trimestre: trimestre,
            hashEvidencia: hashEvidencia,
            oraculo: msg.sender,
            nivel: activos[wallet].nivel,
            tipoActividad: activos[wallet].tipoActividad,
            metadataURI: metadataURI,
            valida: true
        }));

        activos[wallet].estadoCert = CertStatus.CERTIFICADO;
        activos[wallet].ultimaCertQ = block.timestamp;

        emit CertificacionRealizada(wallet, hashEvidencia, trimestre, block.timestamp);
    }

    function registrarHuecoOpacidad(
        address wallet,
        uint256 diaInicio,
        uint256 diaFin,
        string calldata causa
    ) external soloOraculo activoActivo(wallet) {

        huecos[wallet].push(HuecoOpacidad({
            diaInicio: diaInicio,
            diaFin: diaFin,
            timestamp: block.timestamp,
            causa: causa
        }));

        activos[wallet].estadoCert = CertStatus.HUECO_OPACIDAD;
        activos[wallet].diasContinuidad = 0;

        emit HuecoOpacidadRegistrado(wallet, diaInicio, causa, block.timestamp);
    }

    function incrementarContinuidad(address wallet) external soloOraculo activoActivo(wallet) {
        activos[wallet].diasContinuidad += 1;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 5 — GESTIÓN DE ORÁCULOS
    // ═══════════════════════════════════════════════════

    function autorizarOraculo(address oraculo, bool estado) external soloFounder {
        oraculos[oraculo] = estado;
        emit OraculoAutorizado(oraculo, estado);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 6 — SUCESIÓN DEL FOUNDER (2 pasos)
    // ═══════════════════════════════════════════════════

    function iniciarSucesion(address nuevoFounder) external soloFounder {
        require(nuevoFounder != address(0), "Direccion invalida");
        pendingFounder = nuevoFounder;
        emit SucesionIniciada(nuevoFounder);
    }

    function confirmarSucesion() external {
        require(msg.sender == pendingFounder, "Solo pending founder");
        founder = pendingFounder;
        pendingFounder = address(0);
        emit SucesionConfirmada(founder);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 7 — CANCELACIÓN CON REEMBOLSO
    // ═══════════════════════════════════════════════════

    function cancelarActivo() external activoActivo(msg.sender) {
        _cancelarActivo(msg.sender);
    }

    function _cancelarActivo(address wallet) internal {
        uint256 reembolso = activos[wallet].saldo;
        activos[wallet].activo = false;
        activos[wallet].saldo = 0;

        if (reembolso > 0) {
            (bool ok,) = payable(wallet).call{value: reembolso}("");
            require(ok, "Reembolso fallido");
        }

        emit ActivoCancelado(wallet, reembolso, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // MODO SUSPENSIÓN — Fuerza Mayor
    // ═══════════════════════════════════════════════════

    function toggleSuspension(bool activo_) external soloFounder {
        modeSuspension = activo_;
        emit ModeSuspension(activo_, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // AJUSTE DE FEES
    // ═══════════════════════════════════════════════════

    function ajustarFees(
        uint256 _reg,
        uint256 _l1,
        uint256 _l2,
        uint256 _l3
    ) external soloFounder {
        registrationFee = _reg;
        trimestralFee_L1 = _l1;
        trimestralFee_L2 = _l2;
        trimestralFee_L3 = _l3;
        emit FeeAjustado("ALL", block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // VISTAS PÚBLICAS — divididas para evitar stack too deep
    // ═══════════════════════════════════════════════════

    function getCertificaciones(address wallet) external view returns (CertificacionQ[] memory) {
        return certificaciones[wallet];
    }

    function getHuecos(address wallet) external view returns (HuecoOpacidad[] memory) {
        return huecos[wallet];
    }

    function getTotalActivos() external view returns (uint256) {
        return listaActivos.length;
    }

    // Vista 1 — datos de estado
    function getActivoEstado(address wallet) external view returns (
        bool activo,
        PVLevel nivel,
        TipoActividad tipoActividad,
        CertStatus estadoCert,
        uint256 saldo,
        uint256 diasContinuidad
    ) {
        Activo storage a = activos[wallet];
        return (a.activo, a.nivel, a.tipoActividad, a.estadoCert, a.saldo, a.diasContinuidad);
    }

    // Vista 2 — datos de ubicación y registro
    function getActivoUbicacion(address wallet) external view returns (
        string memory nombre,
        int256 latitud,
        int256 longitud,
        uint256 radioKm,
        uint256 fechaRegistro,
        uint256 ultimaCertQ
    ) {
        Activo storage a = activos[wallet];
        return (a.nombre, a.latitud, a.longitud, a.radioKm, a.fechaRegistro, a.ultimaCertQ);
    }

    function getNivelDesc(address wallet) external view returns (string memory) {
        PVLevel nivel = activos[wallet].nivel;
        if (nivel == PVLevel.L1) return PV_L1_DESC;
        if (nivel == PVLevel.L2) return PV_L2_DESC;
        return PV_L3_DESC;
    }

    // ═══════════════════════════════════════════════════
    // INTERNAL UTILS
    // ═══════════════════════════════════════════════════

    function _transferirFounder(uint256 monto) internal {
        (bool ok,) = payable(founder).call{value: monto}("");
        require(ok, "Transferencia founder fallida");
    }

    receive() external payable {
        if (activos[msg.sender].activo) {
            activos[msg.sender].saldo += msg.value;
        }
    }
}
