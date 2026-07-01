// scripts/validarDni.js
module.exports = {
  async run(vars, numero) {
    const dni = (vars.dni || "")
      .replace(/[.\s]/g, "");

    const valido = /^\d{7,8}$/.test(dni);

    return {
      next: valido ? "ok" : "error",
      vars: {
        dni
      }
    };
  }
};