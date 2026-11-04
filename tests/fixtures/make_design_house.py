# Builds design_house.ifc for the design check tests: 2 storeys of 3 m, 12 m (x) x 15 m (y), millimetre units,
# roof slab 300 mm, ground floor spaces Garage (6 x 6 m, front left), Entry (6 x 6 m), Living (12 x 9 m); first floor Bedrooms (12 x 15 m).
# Run: pip install ifcopenshell; python3 tests/fixtures/make_design_house.py
import os
import ifcopenshell, ifcopenshell.api as api
from ifcopenshell.util.shape_builder import ShapeBuilder

f = ifcopenshell.file(schema="IFC4")
proj = api.run("root.create_entity", f, ifc_class="IfcProject", name="Design house")
api.run("unit.assign_unit", f)  # millimetres
model = api.run("context.add_context", f, context_type="Model")
body = api.run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model)
site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
bldg = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="House")
api.run("aggregate.assign_object", f, relating_object=proj, products=[site])
api.run("aggregate.assign_object", f, relating_object=site, products=[bldg])
sb = ShapeBuilder(f)

def box(cls, name, storey, x0, y0, x1, y1, z0, h, **kw):
    e = api.run("root.create_entity", f, ifc_class=cls, name=name, **kw)
    prof = sb.polyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], closed=True)
    solid = sb.extrude(f.createIfcArbitraryClosedProfileDef("AREA", None, prof), h, position=(0.0, 0.0, float(z0)))
    api.run("geometry.assign_representation", f, product=e, representation=sb.get_representation(body, [solid]))
    api.run("geometry.edit_object_placement", f, product=e)
    if cls == "IfcSpace":
        api.run("aggregate.assign_object", f, relating_object=storey, products=[e])
    else:
        api.run("spatial.assign_container", f, relating_structure=storey, products=[e])
    return e

W, D, T = 12000, 15000, 200
for i, (nm, z) in enumerate([("Ground floor", 0), ("First floor", 3000)]):
    st = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name=nm)
    st.Elevation = float(z)
    api.run("aggregate.assign_object", f, relating_object=bldg, products=[st])
    box("IfcSlab", f"{nm} slab", st, 0, 0, W, D, z, T, predefined_type="FLOOR")
    for wn, (a, b, c, d) in {"S": (0, 0, W, T), "N": (0, D - T, W, D), "W": (0, 0, T, D), "E": (W - T, 0, W, D)}.items():
        box("IfcWall", f"{nm} wall {wn}", st, a, b, c, d, z, 3000)
    if i == 0:
        for sn, ln, r in [("G01", "Garage", (0, 0, 6000, 6000)), ("G02", "Entry", (6000, 0, W, 6000)), ("G03", "Living", (0, 6000, W, D))]:
            s = box("IfcSpace", sn, st, *r, z + T, 2700)
            s.LongName = ln
    else:
        s = box("IfcSpace", "F01", st, 0, 0, W, D, z + T, 2700)
        s.LongName = "Bedrooms"
        box("IfcSlab", "Roof", st, 0, 0, W, D, 6000, 300, predefined_type="ROOF")
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "design_house.ifc")
f.write(out)
print("wrote", out)
