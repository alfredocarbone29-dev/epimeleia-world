// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * EPIMELEIA V3.2 — "Blindaje Digital"
 * Notario Digital de Conducta Ambiental Corporativa
 * Red: Polygon Mainnet (Chain ID: 137)
 *
 * Módulos:
 * 1. Registro voluntario de empresas
 * 2. Billing mensual automático (Chainlink Automation compatible)
 * 3. Certificación trimestral (Q) con firma de oráculo
 * 4. Gestión de oráculos autorizados
 * 5. Sucesión del fundador (2 pasos)
 * 6. Cancelación instantánea con reembolso
 *
 * Niveles de Validación (certificación trimestral en todos):
 * PV-L1: Datos satelitales públicos Sentinel/Copernicus. Nivel de entrada.
 * PV-L2: Satelital comercial alta resolución (Planet Labs o equiv.)
 *         + validación cruzada con fuentes públicas.
 *         El oráculo firma solo cuando ambas fuentes son consistentes.
 * PV-L3: Tres fuentes independientes: satelital comercial premium
 *         + sensores IoT en sitio + validación cruzada pública.
 *         Máxima credibilidad auditable.
 */

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

contract EpimeleiaV32 is AutomationCompatibleInterface {

    // ─── OWNER ───────────────────────────────────────────
    address public founder;
    address public pendingFounder;

    // ─── FEES ────────────────────────────────────────────
    uint256 public registrationFee;   // Fee único de registro
    uint256 public monthlyFee_L1;     // PV-L1 mensual
    uint256 public monthlyFee_L2;     // PV-L2 mensual
    uint256 public monthlyFee_L3;     // PV-L3 mensual

    // ─── ENUMS ───────────────────────────────────────────
    enum PVLevel { L1, L2, L3 }
    enum CertStatus { PENDIENTE, CERTIFICADO, HUECO_OPACIDAD }

    // ─── NIVEL DESCRIPTIONS (on-chain) ───────────────────
    // Estas constantes quedan grabadas en el contrato para
    // que cualquier verificador externo pueda consultarlas.
    string public constant PV_L1_DESC = "Certificacion trimestral con datos satelitales publicos Sentinel/Copernicus. Nivel de entrada.";
    string public constant PV_L2_DESC = "Certificacion trimestral con satelital comercial alta resolucion (Planet Labs o equiv.) + validacion cruzada con fuentes publicas. El oraculo firma solo cuando ambas fuentes son consistentes.";
    string public constant PV_L3_DESC = "Certificacion trimestral con tres fuentes independientes: satelital comercial premium + sensores IoT en sitio + validacion cruzada publica. Maxima credibilidad auditable.";

    // ─── STRUCTS ─────────────────────────────────────────
    struct Empresa {
        bool activa;
        PVLevel nivel;
        uint256 saldo;               // Saldo prepagado en contrato
        uint256 ultimoBilling;       // Timestamp último billing
        uint256 diasContinuidad;     // Contador días sin interrupción
        uint256 fechaRegistro;
        CertStatus estadoCert;
        uint256 ultimaCertQ;         // Timestamp última certQ
    }

    struct CertificacionQ {
        uint256 timestamp;
        bytes32 hashEvidencia;       // Hash del reporte firmado por oráculo
        address oraculo;
        PVLevel nivel;
        string metadataURI;          // URI IPFS del reporte completo
        bool valida;
    }

    struct HuecoOpacidad {
        uint256 diaInicio;
        uint256 diaFin;
        uint256 timestamp;
        string causa;                // "SATELLITE_LOSS" | "IOT_INTERRUPTION" | "HUMAN_CAUSE"
    }

    // ─── STORAGE ─────────────────────────────────────────
    mapping(address => Empresa) public empresas;
    mapping(address => CertificacionQ[]) public certificaciones;
    mapping(address => HuecoOpacidad[]) public huecos;
    mapping(address => bool) public oraculos;

    address[] public listaEmpresas;

    // ─── EVENTS ──────────────────────────────────────────
    event EmpresaRegistrada(address indexed wallet, PVLevel nivel, uint256 timestamp);
    event BillingEjecutado(address indexed wallet, uint256 monto, uint256 timestamp);
    event CertificacionRealizada(address indexed wallet, bytes32 hashEvidencia, uint256 trimestre, uint256 timestamp);
    event HuecoOpacidadRegistrado(address indexed wallet, uint256 dia, string causa, uint256 timestamp);
    event EmpresaCancelada(address indexed wallet, uint256 reembolso, uint256 timestamp);
    event OraculoAutorizado(address indexed oraculo, bool estado);
    event SucesionIniciada(address indexed pendingFounder);
    event SucesionConfirmada(address indexed nuevoFounder);
    event ModeSuspension(bool activo, uint256 timestamp);
    event FeeAjustado(string tipo, uint256 nuevoValor);

    // ─── SUSPENSION MODE ─────────────────────────────────
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

    modifier empresaActiva(address wallet) {
        require(empresas[wallet].activa, "Empresa no activa");
        _;
    }

    modifier noSuspension() {
        require(!modeSuspension, "Sistema en Modo Suspension");
        _;
    }

    // ─── CONSTRUCTOR ─────────────────────────────────────
    constructor(
        uint256 _registrationFee,
        uint256 _monthlyFee_L1,
        uint256 _monthlyFee_L2,
        uint256 _monthlyFee_L3
    ) {
        founder = msg.sender;
        registrationFee = _registrationFee;
        monthlyFee_L1 = _monthlyFee_L1;
        monthlyFee_L2 = _monthlyFee_L2;
        monthlyFee_L3 = _monthlyFee_L3;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 1 — REGISTRO DE EMPRESAS
    // ═══════════════════════════════════════════════════

    function registrarEmpresa(PVLevel nivel) external payable noSuspension {
        require(!empresas[msg.sender].activa, "Ya registrada");
        require(msg.value >= registrationFee, "Fee insuficiente");

        empresas[msg.sender] = Empresa({
            activa: true,
            nivel: nivel,
            saldo: msg.value - registrationFee,
            ultimoBilling: block.timestamp,
            diasContinuidad: 0,
            fechaRegistro: block.timestamp,
            estadoCert: CertStatus.PENDIENTE,
            ultimaCertQ: 0
        });

        listaEmpresas.push(msg.sender);
        _transferirFounder(registrationFee);

        emit EmpresaRegistrada(msg.sender, nivel, block.timestamp);
    }

    function cargarSaldo() external payable empresaActiva(msg.sender) {
        empresas[msg.sender].saldo += msg.value;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 2 — BILLING MENSUAL (Chainlink Automation)
    // ═══════════════════════════════════════════════════

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint i = 0; i < listaEmpresas.length; i++) {
            address w = listaEmpresas[i];
            Empresa storage e = empresas[w];
            if (e.activa && block.timestamp >= e.ultimoBilling + 30 days) {
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
        Empresa storage e = empresas[wallet];
        if (!e.activa) return;
        if (block.timestamp < e.ultimoBilling + 30 days) return;

        uint256 fee = _getFeeNivel(e.nivel);

        if (e.saldo >= fee) {
            e.saldo -= fee;
            e.ultimoBilling = block.timestamp;
            _transferirFounder(fee);
            emit BillingEjecutado(wallet, fee, block.timestamp);
        } else {
            _cancelarEmpresa(wallet);
        }
    }

    function _getFeeNivel(PVLevel nivel) internal view returns (uint256) {
        if (nivel == PVLevel.L1) return monthlyFee_L1;
        if (nivel == PVLevel.L2) return monthlyFee_L2;
        return monthlyFee_L3;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 3 — CERTIFICACIÓN TRIMESTRAL (Q)
    // ═══════════════════════════════════════════════════

    /**
     * El oráculo firma y entrega el hash de evidencia.
     * El contrato solo vincula — no juzga.
     * hashEvidencia = keccak256(reporte_completo)
     *
     * PV-L1: el oráculo valida con datos Sentinel/Copernicus públicos.
     * PV-L2: el oráculo valida solo si satelital comercial + fuente pública son consistentes.
     * PV-L3: el oráculo valida solo si satelital comercial + IoT en sitio + fuente pública son consistentes.
     */
    function certificarQ(
        address wallet,
        bytes32 hashEvidencia,
        string calldata metadataURI,
        uint256 trimestre
    ) external soloOraculo empresaActiva(wallet) noSuspension {

        certificaciones[wallet].push(CertificacionQ({
            timestamp: block.timestamp,
            hashEvidencia: hashEvidencia,
            oraculo: msg.sender,
            nivel: empresas[wallet].nivel,
            metadataURI: metadataURI,
            valida: true
        }));

        empresas[wallet].estadoCert = CertStatus.CERTIFICADO;
        empresas[wallet].ultimaCertQ = block.timestamp;

        emit CertificacionRealizada(wallet, hashEvidencia, trimestre, block.timestamp);
    }

    /**
     * Registrar Hueco de Opacidad.
     * Si la señal satelital o IoT se interrumpe por causa humana,
     * se graba un registro imborrable en blockchain.
     */
    function registrarHuecoOpacidad(
        address wallet,
        uint256 diaInicio,
        uint256 diaFin,
        string calldata causa
    ) external soloOraculo empresaActiva(wallet) {

        huecos[wallet].push(HuecoOpacidad({
            diaInicio: diaInicio,
            diaFin: diaFin,
            timestamp: block.timestamp,
            causa: causa
        }));

        empresas[wallet].estadoCert = CertStatus.HUECO_OPACIDAD;
        empresas[wallet].diasContinuidad = 0;

        emit HuecoOpacidadRegistrado(wallet, diaInicio, causa, block.timestamp);
    }

    function incrementarContinuidad(address wallet) external soloOraculo empresaActiva(wallet) {
        empresas[wallet].diasContinuidad += 1;
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 4 — GESTIÓN DE ORÁCULOS
    // ═══════════════════════════════════════════════════

    function autorizarOraculo(address oraculo, bool estado) external soloFounder {
        oraculos[oraculo] = estado;
        emit OraculoAutorizado(oraculo, estado);
    }

    // ═══════════════════════════════════════════════════
    // MÓDULO 5 — SUCESIÓN DEL FOUNDER (2 pasos)
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
    // MÓDULO 6 — CANCELACIÓN CON REEMBOLSO
    // ═══════════════════════════════════════════════════

    function cancelarEmpresa() external empresaActiva(msg.sender) {
        _cancelarEmpresa(msg.sender);
    }

    function _cancelarEmpresa(address wallet) internal {
        uint256 reembolso = empresas[wallet].saldo;
        empresas[wallet].activa = false;
        empresas[wallet].saldo = 0;

        if (reembolso > 0) {
            (bool ok,) = payable(wallet).call{value: reembolso}("");
            require(ok, "Reembolso fallido");
        }

        emit EmpresaCancelada(wallet, reembolso, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // MODO SUSPENSIÓN — Fuerza Mayor
    // ═══════════════════════════════════════════════════

    function toggleSuspension(bool activo) external soloFounder {
        modeSuspension = activo;
        emit ModeSuspension(activo, block.timestamp);
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
        monthlyFee_L1 = _l1;
        monthlyFee_L2 = _l2;
        monthlyFee_L3 = _l3;
        emit FeeAjustado("ALL", block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // VISTAS PÚBLICAS
    // ═══════════════════════════════════════════════════

    function getCertificaciones(address wallet) external view returns (CertificacionQ[] memory) {
        return certificaciones[wallet];
    }

    function getHuecos(address wallet) external view returns (HuecoOpacidad[] memory) {
        return huecos[wallet];
    }

    function getTotalEmpresas() external view returns (uint256) {
        return listaEmpresas.length;
    }

    function getEmpresaInfo(address wallet) external view returns (
        bool activa,
        PVLevel nivel,
        uint256 saldo,
        uint256 diasContinuidad,
        CertStatus estadoCert,
        uint256 ultimaCertQ
    ) {
        Empresa storage e = empresas[wallet];
        return (e.activa, e.nivel, e.saldo, e.diasContinuidad, e.estadoCert, e.ultimaCertQ);
    }

    /**
     * Retorna la descripción on-chain del nivel PV de una empresa.
     * Cualquier verificador externo puede consultarlo sin depender
     * de documentación externa.
     */
    function getNivelDesc(address wallet) external view returns (string memory) {
        PVLevel nivel = empresas[wallet].nivel;
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
        if (empresas[msg.sender].activa) {
            empresas[msg.sender].saldo += msg.value;
        }
    }
}
