#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    int *values = malloc(2 * sizeof(int));
    values[0] = a;
    values[1] = b;
    printf("%d\n", values[0] + values[1]);
    free(values);
    return 0;
}
