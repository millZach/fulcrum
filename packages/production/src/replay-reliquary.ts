import { Document, NodeIO } from "@gltf-transform/core";
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  OctahedronGeometry,
  TorusGeometry,
} from "three";

const addGeometry = (
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  name: string,
  geometry: BufferGeometry,
  material: ReturnType<Document["createMaterial"]>,
): void => {
  geometry.computeVertexNormals();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!positions || !normals) {
    throw new Error(`Geometry ${name} has no renderable attributes.`);
  }
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor(`${name}:positions`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(positions.array)),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor(`${name}:normals`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(normals.array)),
    )
    .setMaterial(material);
  if (geometry.index) {
    const values = Array.from(geometry.index.array);
    const max = Math.max(...values);
    primitive.setIndices(
      document
        .createAccessor(`${name}:indices`, buffer)
        .setType("SCALAR")
        .setArray(
          max > 65_535 ? new Uint32Array(values) : new Uint16Array(values),
        ),
    );
  }
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document
    .getRoot()
    .listScenes()[0]
    ?.addChild(document.createNode(name).setMesh(mesh));
  geometry.dispose();
};

export const createReplayReliquary = async (
  variant: "baseline" | "rear-defined" = "baseline",
): Promise<Uint8Array> => {
  const document = new Document();
  document.createScene("Fulcrum M0 Reliquary");
  const buffer = document.createBuffer("reliquary-buffer");
  const stone = document
    .createMaterial("Weathered basalt")
    .setBaseColorFactor([0.085, 0.105, 0.14, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.86);
  const edgeStone = document
    .createMaterial("Ash edge planes")
    .setBaseColorFactor([0.25, 0.29, 0.34, 1])
    .setMetallicFactor(0.02)
    .setRoughnessFactor(0.78);
  const bronze = document
    .createMaterial("Aged bronze")
    .setBaseColorFactor([0.52, 0.32, 0.16, 1])
    .setMetallicFactor(0.78)
    .setRoughnessFactor(0.42);
  const crystal = document
    .createMaterial("Cyan crystal")
    .setBaseColorFactor([0.13, 0.78, 0.86, 1])
    .setEmissiveFactor([0.12, 0.74, 0.82])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.18);

  addGeometry(
    document,
    buffer,
    "octagonal plinth",
    new CylinderGeometry(1.45, 1.62, 0.32, 8).translate(0, 0.16, 0),
    stone,
  );
  addGeometry(
    document,
    buffer,
    "bronze foot",
    new CylinderGeometry(1.26, 1.42, 0.24, 8).translate(0, 0.43, 0),
    bronze,
  );
  addGeometry(
    document,
    buffer,
    "stone vessel",
    new BoxGeometry(1.9, 1.55, 1.55).translate(0, 1.27, 0),
    stone,
  );
  addGeometry(
    document,
    buffer,
    "crowned shoulder",
    new CylinderGeometry(1.16, 1.34, 0.36, 8).translate(0, 2.13, 0),
    edgeStone,
  );
  addGeometry(
    document,
    buffer,
    "capstone",
    new CylinderGeometry(0.95, 1.14, 0.24, 8).translate(0, 2.43, 0),
    stone,
  );
  for (const [index, height] of [0.73, 1.82, 2.35].entries()) {
    addGeometry(
      document,
      buffer,
      `bronze binding ${index + 1}`,
      new TorusGeometry(index === 1 ? 1.25 : 1.08, 0.085, 8, 32)
        .rotateX(Math.PI / 2)
        .translate(0, height, 0),
      bronze,
    );
  }
  addGeometry(
    document,
    buffer,
    "awakened cyan core",
    new OctahedronGeometry(0.56, 0)
      .scale(0.72, 1.55, 0.72)
      .translate(0, 1.43, 0.88),
    crystal,
  );
  addGeometry(
    document,
    buffer,
    "left core guard",
    new BoxGeometry(0.16, 1.4, 0.18)
      .rotateZ(-0.16)
      .translate(-0.65, 1.42, 0.74),
    bronze,
  );
  addGeometry(
    document,
    buffer,
    "right core guard",
    new BoxGeometry(0.16, 1.4, 0.18).rotateZ(0.16).translate(0.65, 1.42, 0.74),
    bronze,
  );
  if (variant === "rear-defined") {
    addGeometry(
      document,
      buffer,
      "rear cyan core",
      new OctahedronGeometry(0.48, 0)
        .scale(0.76, 1.42, 0.76)
        .translate(0, 1.43, -0.9),
      crystal,
    );
    addGeometry(
      document,
      buffer,
      "rear left guard",
      new BoxGeometry(0.18, 1.28, 0.2)
        .rotateZ(-0.2)
        .translate(-0.62, 1.42, -0.76),
      bronze,
    );
    addGeometry(
      document,
      buffer,
      "rear right guard",
      new BoxGeometry(0.18, 1.28, 0.2)
        .rotateZ(0.2)
        .translate(0.62, 1.42, -0.76),
      bronze,
    );
  }
  document.getRoot().getAsset().generator = "Fulcrum replay asset generator";
  return new NodeIO().writeBinary(document);
};
