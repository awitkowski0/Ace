package com.example.mod;

import java.util.List;
import static net.minecraft.core.Registry.ITEM;

/** Spawns things. @see Registry {@link List} */
@Mixin(Player.class)
public class Spawner<T> extends Base implements Runnable {
    private static final int MAX_SIZE = 16;
    private String name;

    @Override
    public void run() {
        if (name != null && MAX_SIZE > 0) {
            this.name = "zombie\n";
            Item i = new Item(1.5f, 0xFF);
            log(ITEM.get(i).getName());
            list.forEach(Foo::bar);
        }
    }

    public <E> List<E> make(Level level, int count) throws Exception {
        return level.spawn(count);
    }
}
